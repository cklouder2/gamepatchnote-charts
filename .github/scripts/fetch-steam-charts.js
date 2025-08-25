#!/usr/bin/env node

/**
 * Steam Charts Data Fetcher - Maximum Data Without Limits
 * Fetches data directly from Steam APIs without any limits
 * No Supabase dependencies - pure Steam API integration
 */

const fs = require('fs').promises;
const path = require('path');

// Configuration
const OUTPUT_FILE = 'public/data/steam-charts.json';

// Steam API endpoints
const STEAM_API_BASE = 'https://api.steampowered.com';
const STEAMSPY_API_BASE = 'https://steamspy.com/api.php';

// Maximum concurrent requests to avoid rate limiting
const MAX_CONCURRENT_REQUESTS = 10;
const REQUEST_DELAY = 100; // ms between requests

class SteamDataFetcher {
  constructor() {
    this.games = {};
    this.totalPlayers = 0;
    this.processedGames = 0;
  }

  // Helper function to make HTTP requests with retry logic
  async makeRequest(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          return await response.json();
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      } catch (error) {
        console.log(`Request failed (attempt ${i + 1}/${retries}): ${url}`);
        if (i === retries - 1) throw error;
        await this.sleep(1000 * (i + 1)); // Exponential backoff
      }
    }
  }

  // Helper function to add delay between requests
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Fetch most played games from Steam
  async fetchMostPlayedGames() {
    console.log('Fetching most played games from Steam API...');
    try {
      const url = `${STEAM_API_BASE}/ISteamChartsService/GetMostPlayedGames/v1/`;
      const data = await this.makeRequest(url);
      
      if (data?.response?.ranks) {
        console.log(`Found ${data.response.ranks.length} games from Steam Charts`);
        return data.response.ranks.map(game => ({
          appId: game.appid,
          rank: game.rank,
          currentPlayers: game.concurrent || 0,
          peak24h: game.peak_in_game || 0
        }));
      }
    } catch (error) {
      console.log('Steam Charts API failed:', error.message);
    }
    return [];
  }

  // Fetch additional games from SteamSpy
  async fetchSteamSpyGames() {
    console.log('Fetching games from SteamSpy API...');
    try {
      const url = `${STEAMSPY_API_BASE}?request=all`;
      const data = await this.makeRequest(url);
      
      if (data && typeof data === 'object') {
        const games = Object.entries(data)
          .map(([appId, gameData]) => ({
            appId: parseInt(appId),
            name: gameData.name || `Game ${appId}`,
            currentPlayers: 0, // SteamSpy doesn't provide current players
            owners: gameData.owners || 0,
            averagePlaytime: gameData.average_playtime || 0
          }))
          .filter(game => game.appId && game.name);
        
        console.log(`Found ${games.length} games from SteamSpy`);
        return games;
      }
    } catch (error) {
      console.log('SteamSpy API failed:', error.message);
    }
    return [];
  }

  // Fetch current player count for a specific game
  async fetchPlayerCount(appId) {
    try {
      const url = `${STEAM_API_BASE}/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`;
      const data = await this.makeRequest(url);
      
      if (data?.response?.result === 1) {
        return data.response.player_count || 0;
      }
    } catch (error) {
      // Silently continue for individual game failures
    }
    return 0;
  }

  // Process games in batches to get current player counts
  async processGamesInBatches(gamesList) {
    console.log(`Processing ${gamesList.length} games in batches...`);
    const batches = [];
    
    // Split into batches
    for (let i = 0; i < gamesList.length; i += MAX_CONCURRENT_REQUESTS) {
      batches.push(gamesList.slice(i, i + MAX_CONCURRENT_REQUESTS));
    }

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      console.log(`Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} games)`);
      
      const promises = batch.map(async (game) => {
        const currentPlayers = await this.fetchPlayerCount(game.appId);
        await this.sleep(REQUEST_DELAY); // Rate limiting
        
        // Only include games with active players or existing data
        if (currentPlayers > 0 || game.currentPlayers > 0) {
          const finalPlayerCount = Math.max(currentPlayers, game.currentPlayers || 0);
          
          this.games[game.appId] = {
            name: game.name || `Game ${game.appId}`,
            appId: game.appId,
            currentPlayers: finalPlayerCount,
            peak24h: game.peak24h || finalPlayerCount,
            rank: game.rank || this.processedGames + 1,
            trending: this.calculateTrending(finalPlayerCount, game.peak24h || finalPlayerCount)
          };
          
          this.totalPlayers += finalPlayerCount;
          this.processedGames++;
        }
      });

      await Promise.all(promises);
      
      // Progress update
      if (batchIndex % 10 === 0 || batchIndex === batches.length - 1) {
        console.log(`Processed ${this.processedGames} active games so far...`);
      }
    }
  }

  // Calculate trending status
  calculateTrending(current, peak24h) {
    if (!peak24h || peak24h === current) return 'stable';
    const ratio = current / peak24h;
    if (ratio > 0.9) return 'stable';
    if (ratio > 0.7) return 'down';
    return 'down';
  }

  // Main function to fetch all Steam data
  async fetchAllSteamData() {
    console.log('Starting comprehensive Steam data fetch...');
    const startTime = Date.now();

    // Combine data from multiple sources
    const [steamChartsGames, steamSpyGames] = await Promise.all([
      this.fetchMostPlayedGames(),
      this.fetchSteamSpyGames()
    ]);

    // Merge and deduplicate games
    const allGamesMap = new Map();
    
    // Add Steam Charts games (priority data)
    steamChartsGames.forEach(game => {
      allGamesMap.set(game.appId, game);
    });
    
    // Add SteamSpy games (fill in missing names and additional games)
    steamSpyGames.forEach(game => {
      if (allGamesMap.has(game.appId)) {
        // Update existing game with name if missing
        const existing = allGamesMap.get(game.appId);
        existing.name = existing.name || game.name;
      } else {
        // Add new game from SteamSpy
        allGamesMap.set(game.appId, game);
      }
    });

    const allGames = Array.from(allGamesMap.values());
    console.log(`Total unique games found: ${allGames.length}`);

    // Process all games to get current player counts
    await this.processGamesInBatches(allGames);

    // Sort games by current players (descending)
    const sortedGames = Object.values(this.games).sort((a, b) => b.currentPlayers - a.currentPlayers);
    
    // Update ranks based on current players
    sortedGames.forEach((game, index) => {
      game.rank = index + 1;
    });

    // Convert to the required format
    const gamesObject = {};
    sortedGames.forEach(game => {
      gamesObject[game.appId] = game;
    });

    const result = {
      metadata: {
        timestamp: new Date().toISOString(),
        totalGames: Object.keys(gamesObject).length,
        totalPlayers: this.totalPlayers,
        source: "steam-api-direct"
      },
      games: gamesObject
    };

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    console.log(`Fetch completed in ${duration.toFixed(2)} seconds`);
    console.log(`Total games with players: ${result.metadata.totalGames}`);
    console.log(`Total active players: ${result.metadata.totalPlayers.toLocaleString()}`);

    return result;
  }

  // Save data to JSON file
  async saveData(data) {
    const outputDir = path.join(process.cwd(), 'public', 'data');
    const outputFile = path.join(outputDir, 'steam-charts.json');

    // Ensure directory exists
    await fs.mkdir(outputDir, { recursive: true });

    // Write the data
    await fs.writeFile(outputFile, JSON.stringify(data, null, 2));
    console.log(`Data saved to: ${outputFile}`);
    
    // Also create a minified version for production
    const minifiedFile = path.join(outputDir, 'steam-charts.min.json');
    await fs.writeFile(minifiedFile, JSON.stringify(data));
    console.log(`Minified data saved to: ${minifiedFile}`);

    return outputFile;
  }
}

// Main execution
async function main() {
  console.log('=== Steam Charts Data Fetcher ===');
  console.log('Fetching comprehensive Steam game data without limits...');
  
  const fetcher = new SteamDataFetcher();
  
  try {
    const data = await fetcher.fetchAllSteamData();
    await fetcher.saveData(data);
    
    console.log('\n=== Fetch Summary ===');
    console.log(`✅ Successfully fetched data for ${data.metadata.totalGames} games`);
    console.log(`🎮 Total active players: ${data.metadata.totalPlayers.toLocaleString()}`);
    console.log(`📅 Timestamp: ${data.metadata.timestamp}`);
    console.log(`🔗 Source: ${data.metadata.source}`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { SteamDataFetcher };