# GamePatchNote Charts Sync

Public repository for running Steam Charts sync workflow with GitHub Actions (free tier).

## Purpose
This repo runs the Steam Charts data sync every 5 minutes and updates the main GamePatchNote project.

## Features
- Fetches real-time player counts for top 10,000 Steam games
- Updates every 5 minutes via GitHub Actions
- Minimal data format for efficiency
- Free GitHub Actions usage (public repo)

## Configuration
Required secrets:
- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_ANON_KEY`: Supabase anonymous key

## Workflow
The workflow runs automatically every 5 minutes and:
1. Fetches top 10,000 games from database
2. Gets current player counts from Steam API
3. Saves data in minimal JSON format
4. Can be integrated with main project

## Status
![Workflow Status](https://github.com/cklouder2/gamepatchnote-charts/workflows/Steam%20Charts%20Sync%20-%20Ultra%20Fast/badge.svg)# Test
