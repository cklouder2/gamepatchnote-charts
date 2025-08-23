#!/usr/bin/env node

/**
 * Steam Charts Data Fetcher - Full Real Data Version
 * Uses database as single source of truth for games
 * Fetches real player statistics from Steam API for ALL games
 */

require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const OUTPUT_FILE = 'public/data/steam-charts.json';
const LOG_FILE = '.github/logs/steam-charts.log';
const SUMMARY_FILE = '.github/logs/steam-charts-summary.json';

// Steam API endpoints
const STEAM_API_BASE = 'https://api.steampowered.com';
const STEAM_PLAYER_COUNT_ENDPOINT = '/ISteamUserStats/GetNumberOfCurrentPlayers/v1/';
const STEAM_SPY_API = 'https://steamspy.com/api.php'; // Fallback for additional data

class SteamChartsSync {
  constructor() {
    this.supabase = null;
    this.stats = {
      processed: 0,
      updated: 0,
      errors: 0,
      apiCalls: 0,
      cachedGames: 0,
      startTime: new Date()
    };
    this.logs = [];
    this.playerCache = new Map(); // Cache for current session
    
    // Use environment variables for optimization settings
    this.rateLimitDelay = parseInt(process.env.RATE_LIMIT_DELAY) || 2; // 2ms default
    this.batchSize = parseInt(process.env.BATCH_SIZE) || 1000; // 1000 games per batch
    this.maxConcurrent = parseInt(process.env.CONCURRENT_REQUESTS) || 100; // 100 concurrent requests
    this.limitGames = parseInt(process.env.LIMIT_GAMES) || 0; // 0 = no limit
    this.maxGamesDefault = 10000; // Default maximum games to process
  }

  log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    console.log(logEntry);
    this.logs.push(logEntry);
  }

  async initSupabase() {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      this.log('Supabase credentials not found', 'error');
      return false;
    }

    try {
      this.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      this.log('Supabase client initialized successfully');
      return true;
    } catch (error) {
      this.log(`Failed to initialize Supabase: ${error.message}`, 'error');
      return false;
    }
  }

  async fetchSingleGamePlayerCount(appId) {
    try {
      const axios = require('axios');
      
      // Check cache first
      if (this.playerCache.has(appId)) {
        this.stats.cachedGames++;
        return this.playerCache.get(appId);
      }
      
      const url = `${STEAM_API_BASE}${STEAM_PLAYER_COUNT_ENDPOINT}?appid=${appId}`;
      
      const response = await axios.get(url, { 
        timeout: 5000,
        validateStatus: (status) => status < 500
      });
      
      this.stats.apiCalls++;
      
      if (response.data && response.data.response) {
        const playerCount = response.data.response.player_count || 0;
        const result = {
          currentPlayers: playerCount,
          peak24h: Math.floor(playerCount * 1.2), // Estimate
          peakAllTime: Math.floor(playerCount * 2), // Estimate
          lastUpdated: new Date().toISOString()
        };
        
        // Cache the result
        this.playerCache.set(appId, result);
        return result;
      }
      
      return { currentPlayers: 0, peak24h: 0, peakAllTime: 0 };
    } catch (error) {
      // Don't log every single error, just count them
      this.stats.errors++;
      return { currentPlayers: 0, peak24h: 0, peakAllTime: 0 };
    }
  }

  async fetchPlayerStatsForBatch(games) {
    const axios = require('axios');
    const results = new Map();
    
    // Process games in smaller chunks with concurrency control
    for (let i = 0; i < games.length; i += this.maxConcurrent) {
      const chunk = games.slice(i, i + this.maxConcurrent);
      
      const promises = chunk.map(async (game) => {
        const stats = await this.fetchSingleGamePlayerCount(game.appId);
        return { appId: game.appId, stats };
      });
      
      const chunkResults = await Promise.allSettled(promises);
      
      for (const result of chunkResults) {
        if (result.status === 'fulfilled') {
          results.set(result.value.appId, result.value.stats);
        }
      }
      
      // Rate limiting between chunks
      if (i + this.maxConcurrent < games.length) {
        await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay * this.maxConcurrent));
      }
      
      // Progress update every 100 games
      if ((i + this.maxConcurrent) % 100 === 0 || i + this.maxConcurrent >= games.length) {
        const progress = Math.min(i + this.maxConcurrent, games.length);
        this.log(`API Progress: ${progress}/${games.length} games processed`);
      }
    }
    
    return results;
  }

  async fetchTopGamesFromSteamSpy() {
    try {
      const axios = require('axios');
      
      // Still use SteamSpy for top 100 as a priority reference
      const response = await axios.get(
        `${STEAM_SPY_API}?request=top100in2weeks`,
        { timeout: 10000 }
      );
      
      if (response.data) {
        const topGames = [];
        for (const [appId, gameData] of Object.entries(response.data)) {
          if (gameData.ccu) {
            topGames.push({
              appId: appId.toString(),
              currentPlayers: gameData.ccu || 0
            });
          }
        }
        
        // Sort by current players
        topGames.sort((a, b) => b.currentPlayers - a.currentPlayers);
        this.log(`Fetched ${topGames.length} top games from SteamSpy for priority processing`);
        return topGames;
      }
      
      return [];
    } catch (error) {
      this.log(`SteamSpy fetch failed (will use database order): ${error.message}`, 'warn');
      return [];
    }
  }

  async fetchGamesFromDatabase() {
    if (!this.supabase) {
      this.log('Supabase not initialized', 'error');
      return [];
    }

    try {
      // First, try to get games that already have player data (most popular)
      const { data: popularGames, error: popularError } = await this.supabase
        .from('Game')
        .select('appId, currentPlayers')
        .gt('currentPlayers', 0)
        .order('currentPlayers', { ascending: false })
        .limit(10000);
        
      if (popularError) {
        this.log(`Error fetching popular games: ${popularError.message}`, 'warn');
      }
      
      let allGames = popularGames || [];
      
      // If we have less than 10,000, fill with more games
      if (allGames.length < 10000) {
        const remaining = 10000 - allGames.length;
        const popularAppIds = new Set(allGames.map(g => g.appId));
        
        const { data: additionalGames, error: additionalError } = await this.supabase
          .from('Game')
          .select('appId')
          .order('name')
          .limit(remaining * 2); // Get extra to filter
          
        if (additionalError) {
          this.log(`Error fetching additional games: ${additionalError.message}`, 'warn');
        } else if (additionalGames) {
          // Add games not already in the list
          const newGames = additionalGames
            .filter(g => !popularAppIds.has(g.appId))
            .slice(0, remaining);
          allGames = allGames.concat(newGames);
        }
      }
      
      // Ensure we don't exceed 10,000 games
      allGames = allGames.slice(0, 10000);
      
      this.log(`Fetched ${allGames.length} games from database (limited to top 10,000)`);
      return allGames;
    } catch (error) {
      this.log(`Failed to fetch from database: ${error.message}`, 'error');
      return [];
    }
  }

  createMinimalChartsData(games, playerStatsMap) {
    // Create minimal object: appId -> playerCount
    const chartsData = {};
    
    for (const game of games) {
      const stats = playerStatsMap.get(game.appId) || {};
      const currentPlayers = stats.currentPlayers || 0;
      
      // Only include games with players
      if (currentPlayers > 0) {
        chartsData[game.appId] = currentPlayers;
      }
    }
    
    // Sort by player count and return as ordered object
    const sorted = Object.entries(chartsData)
      .sort(([, a], [, b]) => b - a)
      .reduce((obj, [key, value]) => {
        obj[key] = value;
        return obj;
      }, {});
    
    return sorted;
  }

  async saveChartsData(chartsData) {
    try {
      const outputDir = path.dirname(OUTPUT_FILE);
      await fs.mkdir(outputDir, { recursive: true });
      
      const output = {
        metadata: {
          timestamp: new Date().toISOString(),
          source: 'steam-charts-sync',
          totalGames: Object.keys(chartsData).length,
          totalPlayers: Object.values(chartsData).reduce((sum, count) => sum + count, 0)
        },
        charts: chartsData
      };
      
      // Compact JSON without pretty printing to save space
      await fs.writeFile(OUTPUT_FILE, JSON.stringify(output));
      
      // Log file size
      const stats = await fs.stat(OUTPUT_FILE);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      this.log(`Charts data saved: ${sizeMB}MB, ${Object.keys(chartsData).length} games`);
      return true;
    } catch (error) {
      this.log(`Failed to save charts data: ${error.message}`, 'error');
      return false;
    }
  }

  async updateDatabase(playerStatsMap, games) {
    if (!this.supabase) {
      this.log('Skipping database update - Supabase not initialized', 'warn');
      return;
    }

    try {
      // Build updates from stats map
      const updates = [];
      for (const game of games) {
        const stats = playerStatsMap.get(game.appId);
        if (stats && stats.currentPlayers > 0) {
          updates.push({
            appId: game.appId,
            currentPlayers: stats.currentPlayers,
            lastUpdated: new Date().toISOString()
          });
        }
      }
      
      if (updates.length > 0) {
        // Process in batches of 500 to avoid timeouts
        const batchSize = 500;
        let totalUpdated = 0;
        
        for (let i = 0; i < updates.length; i += batchSize) {
          const batch = updates.slice(i, i + batchSize);
          
          const { error } = await this.supabase
            .from('Game')
            .upsert(batch, {
              onConflict: 'appId',
              ignoreDuplicates: false
            });
          
          if (error) {
            this.log(`Database update error for batch ${i / batchSize + 1}: ${error.message}`, 'error');
          } else {
            totalUpdated += batch.length;
          }
        }
        
        this.stats.updated = totalUpdated;
        this.log(`Updated ${totalUpdated} games in database`);
      }
    } catch (error) {
      this.log(`Failed to update database: ${error.message}`, 'error');
    }
  }

  async saveStats() {
    const duration = Math.floor((Date.now() - this.stats.startTime.getTime()) / 1000);
    
    const summary = {
      timestamp: new Date().toISOString(),
      duration,
      stats: this.stats,
      status: this.stats.errors > 0 ? 'partial' : 'success'
    };
    
    try {
      const logDir = path.dirname(LOG_FILE);
      await fs.mkdir(logDir, { recursive: true });
      
      await fs.writeFile(SUMMARY_FILE, JSON.stringify(summary, null, 2));
      await fs.writeFile(LOG_FILE, this.logs.join('\n'));
      
      this.log('Logs saved successfully');
    } catch (error) {
      this.log(`Failed to save logs: ${error.message}`, 'error');
    }
  }

  async run() {
    try {
      this.log('=== Steam Charts Sync Started ===');
      
      // Initialize Supabase
      const supabaseReady = await this.initSupabase();
      
      if (!supabaseReady) {
        throw new Error('Cannot proceed without Supabase connection');
      }
      
      // Fetch all games from database (single source of truth)
      let games = await this.fetchGamesFromDatabase();
      
      if (games.length === 0) {
        throw new Error('No games found in database');
      }
      
      // Apply limit if specified (for testing)
      if (this.limitGames > 0) {
        games = games.slice(0, this.limitGames);
        this.log(`Limited mode: Processing only ${this.limitGames} games`);
      }
      
      this.stats.processed = games.length;
      this.log(`Starting to fetch real player data for ${games.length} games (max 10,000)...`);
      this.log(`Settings: ${this.maxConcurrent} concurrent, ${this.batchSize} batch size, ${this.rateLimitDelay}ms delay`);
      
      if (games.length === 10000) {
        this.log('Note: Limited to top 10,000 most popular games for performance');
      }
      
      // Try to load existing cache first
      let existingData = {};
      try {
        const fs = require('fs').promises;
        const existingFile = await fs.readFile(OUTPUT_FILE, 'utf8');
        const parsed = JSON.parse(existingFile);
        if (parsed.charts) {
          // Create a map of existing player counts for comparison
          for (const game of parsed.charts) {
            existingData[game.appId] = game.currentPlayers || 0;
          }
        }
      } catch (e) {
        this.log('No existing cache found, starting fresh');
      }
      
      // Get top games from SteamSpy for priority
      const topGames = await this.fetchTopGamesFromSteamSpy();
      const topGameIds = new Set(topGames.map(g => g.appId));
      
      // Sort games: prioritize top games, then by existing player count
      const sortedGames = games.sort((a, b) => {
        const aIsTop = topGameIds.has(a.appId);
        const bIsTop = topGameIds.has(b.appId);
        
        if (aIsTop && !bIsTop) return -1;
        if (!aIsTop && bIsTop) return 1;
        
        // Then sort by current players from database
        const aPlayers = a.currentPlayers || existingData[a.appId] || 0;
        const bPlayers = b.currentPlayers || existingData[b.appId] || 0;
        return bPlayers - aPlayers;
      });
      
      // Process games in batches
      this.log(`Processing ${sortedGames.length} games in batches of ${this.batchSize}...`);
      const playerStatsMap = new Map();
      let processedCount = 0;
      
      // Process ALL games with real API calls
      this.log(`Fetching real-time data for ALL ${sortedGames.length} games...`);
      
      for (let i = 0; i < sortedGames.length; i += this.batchSize) {
        const batch = sortedGames.slice(i, i + this.batchSize);
        const batchStats = await this.fetchPlayerStatsForBatch(batch);
        
        for (const [appId, stats] of batchStats) {
          playerStatsMap.set(appId, stats);
        }
        
        processedCount += batch.length;
        
        // Save intermediate results every 5000 games
        if (processedCount % 5000 === 0 || processedCount === sortedGames.length) {
          this.log(`Checkpoint: ${processedCount}/${sortedGames.length} games processed`);
          const intermediateData = this.createMinimalChartsData(sortedGames.slice(0, processedCount), playerStatsMap);
          await this.saveChartsData(intermediateData);
        }
      }
      
      // Create minimal charts data
      const chartsData = this.createMinimalChartsData(sortedGames, playerStatsMap);
      
      // Save final charts data to file
      await this.saveChartsData(chartsData);
      
      // Update database with latest player counts
      await this.updateDatabase(playerStatsMap, sortedGames);
      
      // Save logs and stats
      await this.saveStats();
      
      this.log('=== Steam Charts Sync Completed ===');
      this.log(`Duration: ${Math.floor((Date.now() - this.stats.startTime.getTime()) / 1000)}s`);
      this.log(`Processed: ${this.stats.processed} games`);
      this.log(`API Calls: ${this.stats.apiCalls}`);
      this.log(`Cached: ${this.stats.cachedGames}`);
      this.log(`Updated in DB: ${this.stats.updated}`);
      this.log(`Errors: ${this.stats.errors}`);
      
    } catch (error) {
      this.log(`Critical error: ${error.message}`, 'error');
      this.stats.errors++;
      await this.saveStats();
      process.exit(1);
    }
  }
}

// Run if called directly
if (require.main === module) {
  const sync = new SteamChartsSync();
  sync.run().catch(console.error);
}

module.exports = SteamChartsSync;