#!/usr/bin/env node

/**
 * Steam Charts Data Fetcher - AGGRESSIVE 10,000+ Games Mode
 * Fetches ALL Steam games with extreme parallelization and multiple data sources
 * Target: Minimum 10,000 games, ideally 50,000+
 */

const fs = require('fs').promises;
const path = require('path');

// AGGRESSIVE CONFIGURATION
const OUTPUT_FILE = 'public/data/steam-charts.json';
const MIN_GAMES_REQUIRED = 10000; // MINIMUM requirement
const TARGET_GAMES = 50000; // Target goal
const MAX_CONCURRENT_REQUESTS = 500; // Was 10 - EXTREME PARALLELIZATION
const REQUEST_DELAY = 0; // Was 100ms - NO DELAY FOR MAXIMUM SPEED
const BATCH_SIZE = 5000; // Process in large batches
const MAX_RETRIES = 5; // Retry failed requests
const INTERMEDIATE_SAVE_INTERVAL = 2000; // Save progress every 2000 games

// Steam API endpoints
const STEAM_API_BASE = 'https://api.steampowered.com';
const STEAMSPY_API_BASE = 'https://steamspy.com/api.php';
const STEAMCHARTS_API = 'https://steamcharts.com/api';

class SteamDataFetcher {
  constructor() {
    this.games = {};
    this.allSteamApps = [];
    this.totalPlayers = 0;
    this.processedGames = 0;
    this.failedRequests = 0;
    this.startTime = Date.now();
  }

  // Helper function to make HTTP requests with aggressive retry logic
  async makeRequest(url, retries = MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, { 
          timeout: 10000,
          headers: {
            'User-Agent': 'GamePatchNote-Charts/2.0.0'
          }
        });
        if (response.ok) {
          return await response.json();
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      } catch (error) {
        this.failedRequests++;
        if (i === retries - 1) {
          console.log(`Final request failure: ${url.substring(0, 100)}...`);
          return null;
        }
        // Exponential backoff only on failures
        if (i > 0) await this.sleep(100 * i);
      }
    }
  }

  // Fetch with retry wrapper - returns null on failure instead of throwing
  async fetchWithRetry(url) {
    try {
      return await this.makeRequest(url);
    } catch (error) {
      return null;
    }
  }

  // Helper function to add delay between requests
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Fetch ALL Steam applications (260,000+ apps)
  async fetchAllSteamApps() {
    console.log('🚀 FETCHING ALL STEAM APPS (260,000+ expected)...');
    try {
      const url = `${STEAM_API_BASE}/ISteamApps/GetAppList/v2/`;
      const data = await this.makeRequest(url);
      
      if (data?.applist?.apps) {
        const allApps = data.applist.apps;
        console.log(`✅ Found ${allApps.length.toLocaleString()} total Steam apps`);
        
        // Filter to games only (exclude DLC, software, etc)
        const gameApps = allApps.filter(app => {
          const name = app.name?.toLowerCase() || '';
          return app.name && 
                 !name.includes('dlc') && 
                 !name.includes('soundtrack') &&
                 !name.includes('demo') &&
                 !name.includes('trailer') &&
                 !name.includes('beta') &&
                 !name.includes('test') &&
                 !name.includes('dedicated server') &&
                 name.length > 1;
        });
        
        console.log(`🎮 Filtered to ${gameApps.length.toLocaleString()} potential games`);
        this.allSteamApps = gameApps;
        return gameApps;
      }
    } catch (error) {
      console.log('❌ Steam GetAppList API failed:', error.message);
    }
    return [];
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

  // Fetch games from SteamSpy (multiple pages for maximum coverage)
  async fetchSteamSpyGames() {
    console.log('🔍 FETCHING ALL STEAMSPY GAMES (pages 0-100)...');
    const allGames = [];
    
    // Fetch from multiple SteamSpy endpoints
    const requests = [
      // Primary all games request
      `${STEAMSPY_API_BASE}?request=all`,
      // Top games by player count
      `${STEAMSPY_API_BASE}?request=top100in2weeks`,
      `${STEAMSPY_API_BASE}?request=top100forever`,
      `${STEAMSPY_API_BASE}?request=top100owned`
    ];
    
    for (const url of requests) {
      try {
        console.log(`Fetching: ${url}`);
        const data = await this.makeRequest(url);
        
        if (data && typeof data === 'object') {
          const games = Object.entries(data)
            .map(([appId, gameData]) => ({
              appId: parseInt(appId),
              name: gameData.name || `Game ${appId}`,
              currentPlayers: 0, // SteamSpy doesn't provide current players
              owners: gameData.owners || 0,
              averagePlaytime: gameData.average_playtime || 0,
              source: 'steamspy'
            }))
            .filter(game => game.appId && game.name && !isNaN(game.appId));
          
          allGames.push(...games);
        }
      } catch (error) {
        console.log(`SteamSpy request failed: ${url} - ${error.message}`);
      }
    }
    
    // Deduplicate by appId
    const uniqueGames = [];
    const seenIds = new Set();
    for (const game of allGames) {
      if (!seenIds.has(game.appId)) {
        seenIds.add(game.appId);
        uniqueGames.push(game);
      }
    }
    
    console.log(`✅ Found ${uniqueGames.length} unique games from SteamSpy`);
    return uniqueGames;
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

  // AGGRESSIVE PARALLEL PROCESSING - 500 concurrent requests
  async fetchPlayerCountsParallel(appIds) {
    console.log(`🚀 PROCESSING ${appIds.length.toLocaleString()} games with ${MAX_CONCURRENT_REQUESTS} concurrent requests...`);
    
    const promises = appIds.map(appId => 
      this.fetchWithRetry(`${STEAM_API_BASE}/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`)
        .then(data => ({
          appId,
          players: data?.response?.result === 1 ? (data.response.player_count || 0) : 0
        }))
        .catch(() => ({ appId, players: 0 }))
    );
    
    // Process in batches of MAX_CONCURRENT_REQUESTS
    const results = [];
    for (let i = 0; i < promises.length; i += MAX_CONCURRENT_REQUESTS) {
      const batch = promises.slice(i, i + MAX_CONCURRENT_REQUESTS);
      console.log(`Processing batch ${Math.floor(i / MAX_CONCURRENT_REQUESTS) + 1}/${Math.ceil(promises.length / MAX_CONCURRENT_REQUESTS)} (${batch.length} games)...`);
      
      const batchResults = await Promise.all(batch);
      results.push(...batchResults);
      
      // Progress update and intermediate saving
      if (results.length % INTERMEDIATE_SAVE_INTERVAL === 0 || i + MAX_CONCURRENT_REQUESTS >= promises.length) {
        console.log(`⚡ Processed ${results.length.toLocaleString()}/${promises.length.toLocaleString()} games (${Math.round(results.length/promises.length*100)}%)`);
        console.log(`⚡ Failed requests: ${this.failedRequests}, Success rate: ${Math.round((results.length - this.failedRequests)/results.length*100)}%`);
        
        // Save intermediate results
        if (results.length % INTERMEDIATE_SAVE_INTERVAL === 0) {
          await this.saveIntermediateResults(results);
        }
      }
      
      // No delay between batches - MAXIMUM SPEED
    }
    
    return results;
  }

  // Save intermediate progress
  async saveIntermediateResults(results) {
    try {
      const activeGames = results.filter(r => r.players > 0);
      console.log(`💾 Saving intermediate results: ${activeGames.length} games with players...`);
      
      const outputDir = path.join(process.cwd(), 'public', 'data');
      await fs.mkdir(outputDir, { recursive: true });
      
      const tempFile = path.join(outputDir, `steam-charts-temp-${Date.now()}.json`);
      await fs.writeFile(tempFile, JSON.stringify({ 
        partial: true,
        processed: results.length,
        activeGames: activeGames.length,
        timestamp: new Date().toISOString(),
        results: activeGames.slice(0, 1000) // Save top 1000 for preview
      }, null, 2));
    } catch (error) {
      console.log('Warning: Failed to save intermediate results:', error.message);
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

  // MAIN AGGRESSIVE DATA FETCHING - Target: 10,000+ games
  async fetchAllSteamData() {
    console.log('🔥 STARTING AGGRESSIVE 10,000+ GAMES FETCH MODE 🔥');
    console.log(`Target: ${MIN_GAMES_REQUIRED.toLocaleString()}+ games minimum, ${TARGET_GAMES.toLocaleString()} games ideal`);
    
    this.startTime = Date.now();

    // PHASE 1: Fetch ALL Steam apps (260k+) and other sources in parallel
    console.log('\n📡 PHASE 1: FETCHING FROM ALL DATA SOURCES...');
    const [allSteamApps, steamChartsGames, steamSpyGames] = await Promise.all([
      this.fetchAllSteamApps(),
      this.fetchMostPlayedGames(),
      this.fetchSteamSpyGames()
    ]);

    // PHASE 2: Merge and prioritize all games
    console.log('\n🔄 PHASE 2: MERGING AND DEDUPLICATING ALL SOURCES...');
    const allGamesMap = new Map();
    
    // Priority 1: Steam Charts games (have current player data)
    steamChartsGames.forEach(game => {
      allGamesMap.set(game.appId, { ...game, priority: 1, source: 'steam-charts' });
    });
    
    // Priority 2: SteamSpy games (have metadata)
    steamSpyGames.forEach(game => {
      if (allGamesMap.has(game.appId)) {
        const existing = allGamesMap.get(game.appId);
        existing.name = existing.name || game.name;
        existing.owners = game.owners;
      } else {
        allGamesMap.set(game.appId, { ...game, priority: 2, source: 'steamspy' });
      }
    });
    
    // Priority 3: All Steam Apps (massive coverage)
    let addedFromAllApps = 0;
    allSteamApps.forEach(app => {
      if (!allGamesMap.has(app.appid)) {
        allGamesMap.set(app.appid, {
          appId: app.appid,
          name: app.name,
          currentPlayers: 0,
          priority: 3,
          source: 'steam-all-apps'
        });
        addedFromAllApps++;
      }
    });

    const allUniqueGames = Array.from(allGamesMap.values());
    console.log(`✅ MERGED RESULTS:`);
    console.log(`   Steam Charts: ${steamChartsGames.length.toLocaleString()} games`);
    console.log(`   SteamSpy: ${steamSpyGames.length.toLocaleString()} games`);
    console.log(`   Steam All Apps: ${addedFromAllApps.toLocaleString()} new games`);
    console.log(`   TOTAL UNIQUE: ${allUniqueGames.length.toLocaleString()} games`);

    // PHASE 3: Intelligent sampling for TARGET_GAMES
    let gamesToProcess = allUniqueGames;
    if (allUniqueGames.length > TARGET_GAMES) {
      console.log(`\n🎯 PHASE 3: INTELLIGENT SAMPLING TO ${TARGET_GAMES.toLocaleString()} games...`);
      
      // Keep all priority 1 & 2 games, sample from priority 3
      const priority1And2 = allUniqueGames.filter(g => g.priority <= 2);
      const priority3Games = allUniqueGames.filter(g => g.priority === 3);
      
      const remainingSlots = TARGET_GAMES - priority1And2.length;
      const sampledPriority3 = this.randomSample(priority3Games, remainingSlots);
      
      gamesToProcess = [...priority1And2, ...sampledPriority3];
      console.log(`   Keeping all ${priority1And2.length.toLocaleString()} high-priority games`);
      console.log(`   Sampling ${sampledPriority3.length.toLocaleString()} from ${priority3Games.length.toLocaleString()} Steam apps`);
    }

    // PHASE 4: MASSIVE PARALLEL PLAYER COUNT FETCHING
    console.log(`\n🚀 PHASE 4: FETCHING PLAYER COUNTS FOR ${gamesToProcess.length.toLocaleString()} GAMES...`);
    const appIds = gamesToProcess.map(g => g.appId);
    const playerResults = await this.fetchPlayerCountsParallel(appIds);

    // PHASE 5: Process results and build final dataset
    console.log('\n📊 PHASE 5: BUILDING FINAL DATASET...');
    const gamesWithPlayers = [];
    const gameMap = new Map(gamesToProcess.map(g => [g.appId, g]));
    
    playerResults.forEach(result => {
      const gameInfo = gameMap.get(result.appId);
      if (gameInfo && (result.players > 0 || gameInfo.currentPlayers > 0)) {
        const finalPlayerCount = Math.max(result.players, gameInfo.currentPlayers || 0);
        
        gamesWithPlayers.push({
          name: gameInfo.name || `Game ${result.appId}`,
          appId: result.appId,
          currentPlayers: finalPlayerCount,
          peak24h: gameInfo.peak24h || finalPlayerCount,
          trending: this.calculateTrending(finalPlayerCount, gameInfo.peak24h || finalPlayerCount),
          source: gameInfo.source,
          owners: gameInfo.owners || 0
        });
        
        this.totalPlayers += finalPlayerCount;
      }
    });

    // VALIDATION: Ensure minimum requirement
    if (gamesWithPlayers.length < MIN_GAMES_REQUIRED) {
      throw new Error(`❌ FAILED: Only ${gamesWithPlayers.length} games with player data found. Minimum required: ${MIN_GAMES_REQUIRED}`);
    }

    // Sort by current players and assign ranks
    gamesWithPlayers.sort((a, b) => b.currentPlayers - a.currentPlayers);
    gamesWithPlayers.forEach((game, index) => {
      game.rank = index + 1;
    });

    // Final result
    const gamesObject = {};
    gamesWithPlayers.forEach(game => {
      gamesObject[game.appId] = game;
    });

    const result = {
      metadata: {
        timestamp: new Date().toISOString(),
        totalGames: Object.keys(gamesObject).length,
        totalPlayers: this.totalPlayers,
        totalProcessed: playerResults.length,
        failedRequests: this.failedRequests,
        duration: (Date.now() - this.startTime) / 1000,
        source: "aggressive-multi-source",
        version: "2.0.0-aggressive",
        requirement: `Minimum ${MIN_GAMES_REQUIRED} games - ${gamesWithPlayers.length >= MIN_GAMES_REQUIRED ? 'MET ✅' : 'FAILED ❌'}`
      },
      games: gamesObject
    };

    console.log('\n🎉 FETCH COMPLETED SUCCESSFULLY! 🎉');
    console.log(`✅ Final games with players: ${result.metadata.totalGames.toLocaleString()}`);
    console.log(`🎮 Total active players: ${result.metadata.totalPlayers.toLocaleString()}`);
    console.log(`⏱️  Duration: ${result.metadata.duration.toFixed(2)} seconds`);
    console.log(`📊 Success rate: ${Math.round((1 - this.failedRequests/playerResults.length) * 100)}%`);
    console.log(result.metadata.requirement);

    return result;
  }

  // Random sampling utility
  randomSample(array, size) {
    if (array.length <= size) return array;
    const shuffled = [...array].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, size);
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
  console.log('🔥🔥🔥 AGGRESSIVE STEAM CHARTS DATA FETCHER v2.0 🔥🔥🔥');
  console.log(`MISSION: Fetch minimum ${MIN_GAMES_REQUIRED.toLocaleString()} games, target ${TARGET_GAMES.toLocaleString()} games`);
  console.log(`CONFIG: ${MAX_CONCURRENT_REQUESTS} concurrent requests, ${REQUEST_DELAY}ms delay, ${MAX_RETRIES} retries`);
  
  const fetcher = new SteamDataFetcher();
  
  try {
    const data = await fetcher.fetchAllSteamData();
    
    // CRITICAL VALIDATION
    if (data.metadata.totalGames < MIN_GAMES_REQUIRED) {
      throw new Error(`VALIDATION FAILED: Only ${data.metadata.totalGames} games fetched. Minimum required: ${MIN_GAMES_REQUIRED}`);
    }
    
    await fetcher.saveData(data);
    
    console.log('\n🎯🎯🎯 MISSION ACCOMPLISHED! 🎯🎯🎯');
    console.log('='.repeat(50));
    console.log(`✅ Games with player data: ${data.metadata.totalGames.toLocaleString()}`);
    console.log(`🎮 Total active players: ${data.metadata.totalPlayers.toLocaleString()}`);
    console.log(`📊 Total games processed: ${data.metadata.totalProcessed.toLocaleString()}`);
    console.log(`⚡ Success rate: ${Math.round((1 - data.metadata.failedRequests/data.metadata.totalProcessed) * 100)}%`);
    console.log(`⏱️  Total duration: ${data.metadata.duration.toFixed(2)} seconds`);
    console.log(`📅 Timestamp: ${data.metadata.timestamp}`);
    console.log(`🔗 Source: ${data.metadata.source} v${data.metadata.version}`);
    console.log(`🎯 Requirement Status: ${data.metadata.requirement}`);
    console.log('='.repeat(50));
    
    // Success metrics
    const avgPlayersPerGame = Math.round(data.metadata.totalPlayers / data.metadata.totalGames);
    console.log(`📈 Average players per game: ${avgPlayersPerGame.toLocaleString()}`);
    console.log(`🚀 Processing rate: ${Math.round(data.metadata.totalProcessed / data.metadata.duration).toLocaleString()} games/second`);
    
    if (data.metadata.totalGames >= TARGET_GAMES) {
      console.log('🏆 TARGET EXCEEDED! Mission accomplished beyond expectations!');
    } else if (data.metadata.totalGames >= MIN_GAMES_REQUIRED) {
      console.log('✅ MINIMUM REQUIREMENT MET! Mission successful!');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌❌❌ MISSION FAILED ❌❌❌');
    console.error('Fatal error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { SteamDataFetcher };