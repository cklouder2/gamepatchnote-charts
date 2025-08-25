#!/usr/bin/env node

/**
 * SteamSpy Data Fetcher - 20,000+ Active Games
 * Fetches all active games from SteamSpy API
 * Guaranteed minimum 10,000 games, target 20,000+
 */

const https = require('https');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const OUTPUT_FILE = 'public/data/steam-charts.json';
const MIN_GAMES_REQUIRED = 10000;
const TARGET_GAMES = 20000;
const MAX_PAGES = 100; // SteamSpy usually has ~86 pages
const STEAMSPY_API_BASE = 'https://steamspy.com/api.php';

class SteamSpyFetcher {
  constructor() {
    this.games = {};
    this.totalPlayers = 0;
    this.totalGames = 0;
    this.activeGames = 0;
    this.startTime = Date.now();
  }

  // Helper function to make HTTPS requests
  fetchJson(url) {
    return new Promise((resolve) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            console.log(`Failed to parse JSON from ${url}: ${e.message}`);
            resolve(null);
          }
        });
      }).on('error', (error) => {
        console.log(`Request failed for ${url}: ${error.message}`);
        resolve(null);
      });
    });
  }

  // Fetch games from a specific page
  async fetchPage(page) {
    const url = `${STEAMSPY_API_BASE}?request=all&page=${page}`;
    console.log(`Fetching page ${page}...`);
    
    const data = await this.fetchJson(url);
    
    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
      console.log(`Page ${page}: No data or empty page`);
      return null;
    }
    
    const games = Object.entries(data);
    let pageActiveCount = 0;
    
    games.forEach(([appId, game]) => {
      this.totalGames++;
      
      // Only include games with active players (ccu > 0)
      if (game.ccu > 0) {
        this.activeGames++;
        pageActiveCount++;
        this.totalPlayers += game.ccu;
        
        // Store game data
        this.games[appId] = {
          name: game.name || `Game ${appId}`,
          appId: parseInt(appId),
          currentPlayers: game.ccu,
          peak24h: game.ccu, // SteamSpy doesn't provide 24h peak
          trending: 'stable',
          owners: game.owners || '0',
          positive: game.positive || 0,
          negative: game.negative || 0,
          averagePlaytime: game.average_forever || 0,
          medianPlaytime: game.median_forever || 0,
          price: game.price || 0,
          initialPrice: game.initialprice || 0,
          discount: game.discount || 0,
          languages: game.languages || '',
          genre: game.genre || '',
          publisher: game.publisher || '',
          developer: game.developer || '',
          tags: game.tags || {},
          source: 'steamspy'
        };
      }
    });
    
    console.log(`Page ${page}: ${games.length} total games, ${pageActiveCount} with active players`);
    return pageActiveCount;
  }

  // Fetch games from tag endpoints for additional coverage
  async fetchTagGames() {
    console.log('\n🏷️ Fetching additional games from popular tags...');
    
    const tags = [
      'Multiplayer',
      'Free to Play',
      'Early Access',
      'Action',
      'Indie',
      'VR',
      'Co-op',
      'Survival',
      'RPG',
      'Strategy'
    ];
    
    let newGamesAdded = 0;
    
    for (const tag of tags) {
      const url = `${STEAMSPY_API_BASE}?request=tag&tag=${encodeURIComponent(tag)}`;
      console.log(`Fetching tag: ${tag}...`);
      
      const data = await this.fetchJson(url);
      
      if (data && typeof data === 'object') {
        const games = Object.entries(data);
        let tagActiveCount = 0;
        
        games.forEach(([appId, game]) => {
          // Only add if not already in our list and has active players
          if (!this.games[appId] && game.ccu > 0) {
            this.activeGames++;
            tagActiveCount++;
            newGamesAdded++;
            this.totalPlayers += game.ccu;
            
            this.games[appId] = {
              name: game.name || `Game ${appId}`,
              appId: parseInt(appId),
              currentPlayers: game.ccu,
              peak24h: game.ccu,
              trending: 'stable',
              owners: game.owners || '0',
              positive: game.positive || 0,
              negative: game.negative || 0,
              averagePlaytime: game.average_forever || 0,
              medianPlaytime: game.median_forever || 0,
              price: game.price || 0,
              initialPrice: game.initialprice || 0,
              discount: game.discount || 0,
              tags: { [tag]: true, ...(game.tags || {}) },
              source: 'steamspy-tag'
            };
          }
        });
        
        console.log(`Tag '${tag}': ${tagActiveCount} new active games added`);
      }
    }
    
    console.log(`✅ Added ${newGamesAdded} new games from tag endpoints`);
    return newGamesAdded;
  }

  // Main fetching function
  async fetchAllGames() {
    console.log('🚀 Starting SteamSpy data fetch for 20,000+ active games...');
    console.log(`Target: Minimum ${MIN_GAMES_REQUIRED.toLocaleString()} games, ideally ${TARGET_GAMES.toLocaleString()}+\n`);
    
    // Phase 1: Fetch all pages
    console.log('📡 PHASE 1: Fetching all SteamSpy pages...');
    let emptyPages = 0;
    
    for (let page = 0; page < MAX_PAGES; page++) {
      const activeCount = await this.fetchPage(page);
      
      if (activeCount === null) {
        emptyPages++;
        if (emptyPages >= 3) {
          console.log(`Stopped at page ${page} (3 consecutive empty pages)`);
          break;
        }
      } else {
        emptyPages = 0;
        
        // Progress update
        if ((page + 1) % 10 === 0) {
          console.log(`\n📊 Progress after ${page + 1} pages:`);
          console.log(`   Total games scanned: ${this.totalGames.toLocaleString()}`);
          console.log(`   Active games found: ${this.activeGames.toLocaleString()}`);
          console.log(`   Total players: ${this.totalPlayers.toLocaleString()}\n`);
        }
      }
    }
    
    console.log(`\n✅ Phase 1 complete: ${this.activeGames.toLocaleString()} active games from main pages`);
    
    // Phase 2: Fetch additional games from tags if needed
    if (this.activeGames < TARGET_GAMES) {
      console.log('\n📡 PHASE 2: Fetching additional games from tag endpoints...');
      await this.fetchTagGames();
    }
    
    // Sort games by player count and assign ranks
    const sortedGames = Object.values(this.games)
      .sort((a, b) => b.currentPlayers - a.currentPlayers);
    
    sortedGames.forEach((game, index) => {
      game.rank = index + 1;
    });
    
    // Rebuild games object with sorted data
    const sortedGamesObject = {};
    sortedGames.forEach(game => {
      sortedGamesObject[game.appId] = game;
    });
    
    // Create final result
    const result = {
      metadata: {
        timestamp: new Date().toISOString(),
        totalGames: sortedGames.length,
        totalPlayers: this.totalPlayers,
        totalScanned: this.totalGames,
        duration: (Date.now() - this.startTime) / 1000,
        source: 'steamspy-comprehensive',
        version: '3.0.0',
        requirement: `Minimum ${MIN_GAMES_REQUIRED} games - ${sortedGames.length >= MIN_GAMES_REQUIRED ? 'MET ✅' : 'FAILED ❌'}`
      },
      games: sortedGamesObject
    };
    
    // Validation
    if (result.metadata.totalGames < MIN_GAMES_REQUIRED) {
      throw new Error(`❌ FAILED: Only ${result.metadata.totalGames} active games found. Minimum required: ${MIN_GAMES_REQUIRED}`);
    }
    
    console.log('\n🎉 FETCH COMPLETED SUCCESSFULLY! 🎉');
    console.log(`✅ Active games found: ${result.metadata.totalGames.toLocaleString()}`);
    console.log(`🎮 Total active players: ${result.metadata.totalPlayers.toLocaleString()}`);
    console.log(`📊 Total games scanned: ${result.metadata.totalScanned.toLocaleString()}`);
    console.log(`⏱️  Duration: ${result.metadata.duration.toFixed(2)} seconds`);
    console.log(result.metadata.requirement);
    
    return result;
  }

  // Save data to JSON files
  async saveData(data) {
    const outputDir = path.join(process.cwd(), 'public', 'data');
    const outputFile = path.join(outputDir, 'steam-charts.json');
    
    // Ensure directory exists
    await fs.mkdir(outputDir, { recursive: true });
    
    // Write the full data
    await fs.writeFile(outputFile, JSON.stringify(data, null, 2));
    console.log(`\n💾 Data saved to: ${outputFile}`);
    
    // Create minified version
    const minifiedFile = path.join(outputDir, 'steam-charts.min.json');
    await fs.writeFile(minifiedFile, JSON.stringify(data));
    console.log(`💾 Minified data saved to: ${minifiedFile}`);
    
    // Create a summary file
    const summary = {
      metadata: data.metadata,
      topGames: Object.values(data.games).slice(0, 100).map(g => ({
        name: g.name,
        appId: g.appId,
        players: g.currentPlayers,
        rank: g.rank
      }))
    };
    
    const summaryFile = path.join(outputDir, 'steam-charts-summary.json');
    await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2));
    console.log(`💾 Summary saved to: ${summaryFile}`);
    
    return outputFile;
  }
}

// Main execution
async function main() {
  console.log('🔥 STEAMSPY DATA FETCHER v3.0 🔥');
  console.log('=' .repeat(50));
  
  const fetcher = new SteamSpyFetcher();
  
  try {
    const data = await fetcher.fetchAllGames();
    await fetcher.saveData(data);
    
    console.log('\n' + '='.repeat(50));
    console.log('🏆 MISSION ACCOMPLISHED! 🏆');
    console.log('=' .repeat(50));
    
    // Success metrics
    const avgPlayersPerGame = Math.round(data.metadata.totalPlayers / data.metadata.totalGames);
    console.log(`📈 Average players per game: ${avgPlayersPerGame.toLocaleString()}`);
    console.log(`🚀 Processing rate: ${Math.round(data.metadata.totalScanned / data.metadata.duration).toLocaleString()} games/second`);
    
    // Milestones
    console.log('\n🎯 MILESTONES:');
    if (data.metadata.totalGames >= 10000) console.log('   ✅ 10,000+ active games');
    if (data.metadata.totalGames >= 15000) console.log('   ✅ 15,000+ active games');
    if (data.metadata.totalGames >= 20000) console.log('   ✅ 20,000+ active games');
    if (data.metadata.totalGames >= 25000) console.log('   ✅ 25,000+ active games');
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ MISSION FAILED ❌');
    console.error('Fatal error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { SteamSpyFetcher };