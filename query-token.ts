import { Connection, Keypair, PublicKey, AccountInfo } from "@solana/web3.js";
import { Raydium } from "../src";
import * as fs from "fs";
import { ApiV3PoolInfoItem, ApiV3Token } from "../src/api/type";
import axios, { AxiosError } from "axios";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

interface TokenWithLiquidity {
  address: string;
  symbol: string;
  name: string;
  solLiquidity: number;
  poolId: string;
  priceInSol: number;
  priceInUsd: number;
  volume24h: number;
  highestPrice24h: number;
  highestPrice7d: number;
  highestPrice30d: number;
  allTimeHighPrice: number;
  timestamp: string; // Changed from creationDate
}

interface PriceChange {
  symbol: string;
  name: string;
  address: string; // Add this line
  oldPriceUsd: number;
  newPriceUsd: number;
  percentChange: number;
  solLiquidity: number; // Add this line
}

interface VolumeChange {
  symbol: string;
  name: string;
  address: string; // Add this line
  oldVolume: number;
  newVolume: number;
  percentChange: number;
  solLiquidity: number; // Add this line
}

async function main() {
  const scriptTimestamp = new Date().toISOString();
  console.log(`Script started at: ${scriptTimestamp}`);

  // Get SOL price in USD from user input
  const solPriceUsd = parseFloat(process.argv[2]);
  if (isNaN(solPriceUsd) || solPriceUsd <= 0) {
    console.error("Please provide a valid SOL price in USD as an argument.");
    process.exit(1);
  }

  console.log(`SOL price set to: $${solPriceUsd}`);
  const outputFolder = "raydium_outputs/output";
  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder);
    console.log(`Created output folder: ${outputFolder}`);
  }

  // Use the RPC_ENDPOINT from .env, fallback to default if not set
  const rpcEndpoint = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
  console.log(`Using RPC endpoint: ${rpcEndpoint}`);

  console.log("Initializing Solana connection");
  const connection = new Connection(rpcEndpoint, "confirmed");
  const owner = Keypair.generate();
  console.log("Generating owner keypair");

  console.log("Loading Raydium");
  const raydium = await Raydium.load({
    connection,
    owner: owner.publicKey,
  });
  console.log("Raydium loaded successfully");

  // Get the current run number by counting only relevant JSON files
  const existingJsonFiles = fs
    .readdirSync(outputFolder)
    .filter(
      (file) =>
        file.startsWith("raydium_tokens_with_liquidity_") && file.endsWith(".json") && file !== "token_comparison.json",
    );
  const runNumber = existingJsonFiles.length;
  console.log(`Current run number: ${runNumber + 1}`);

  // Read the most recent JSON file if it exists
  let existingTokens: TokenWithLiquidity[] = [];
  if (runNumber > 0) {
    const latestFile = existingJsonFiles[existingJsonFiles.length - 1];
    const latestFilePath = path.join(outputFolder, latestFile);
    existingTokens = JSON.parse(fs.readFileSync(latestFilePath, "utf-8"));
    console.log(`Loaded ${existingTokens.length} tokens from previous run`);
  }

  console.log("Fetching token list...");
  const tokenListResponse = await raydium.api.getTokenList();
  console.log(`Fetched ${tokenListResponse.mintList.length} tokens from Raydium`);

  const tokensWithLiquidity: TokenWithLiquidity[] = [];
  const processedTokens = new Set<string>();

  console.log("Fetching pool list...");
  let page = 1;
  let hasNextPage = true;
  let lowLiquidityCount = 0;
  const PAGE_SIZE = 1000;
  const accountInfoCache = new Map<string, AccountInfo<Buffer> | null>();

  async function batchGetAccountInfo(
    connection: Connection,
    addresses: string[],
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    const BATCH_SIZE = 25;
    const results: (AccountInfo<Buffer> | null)[] = [];
    const uncachedAddresses: string[] = [];

    // Check cache first
    addresses.forEach((address) => {
      if (accountInfoCache.has(address)) {
        results.push(accountInfoCache.get(address)!);
      } else {
        uncachedAddresses.push(address);
      }
    });

    // Process uncached addresses in smaller batches
    for (let i = 0; i < uncachedAddresses.length; i += BATCH_SIZE) {
      const batch = uncachedAddresses.slice(i, i + BATCH_SIZE);

      // Add exponential backoff retry logic
      let retries = 3;
      let delay = 1000;

      while (retries > 0) {
        try {
          const batchPromises = batch.map((address) => connection.getAccountInfo(new PublicKey(address)));

          const batchResults = await Promise.all(batchPromises);

          // Cache the results
          batch.forEach((address, index) => {
            accountInfoCache.set(address, batchResults[index]);
          });

          results.push(...batchResults);

          // Successful batch, wait longer between batches
          await new Promise((resolve) => setTimeout(resolve, 2000));
          break;
        } catch (error) {
          retries--;
          if (retries === 0) throw error;

          // Exponential backoff
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay += 1000;
        }
      }
    }

    return results;
  }

  while (hasNextPage && lowLiquidityCount < 5000) {
    console.log(`Fetching page ${page} of pool list`);
    const poolList = await raydium.api.getPoolList({ page, pageSize: PAGE_SIZE });

    if (!poolList.data || poolList.data.length === 0) {
      console.log("No more pool data available");
      break;
    }

    console.log(`Fetched ${poolList.data.length} pools from page ${page}`);

    // Collect addresses to batch
    const pageTokens: Array<{
      pool: any;
      tokenInfo: ApiV3Token;
      solLiquidity: number;
      priceInSol: number;
      volume24h: number;
      highestPrice24hInSol: number;
      highestPrice7dInSol: number;
      highestPrice30dInSol: number;
    }> = [];

    // First pass: collect all valid tokens
    for (const pool of poolList.data) {
      let solLiquidity = 0;
      let tokenInfo: ApiV3Token | undefined;
      let priceInSol = 0;
      let volume24h = 0;
      let highestPrice24hInSol = 0;
      let highestPrice7dInSol = 0;
      let highestPrice30dInSol = 0;

      if (pool.mintA.address === "So11111111111111111111111111111111111111112") {
        solLiquidity = pool.mintAmountA;
        tokenInfo = pool.mintB;
        priceInSol = 1 / pool.price;
        volume24h = pool.day.volume * solPriceUsd;
        highestPrice24hInSol = 1 / pool.day.priceMin;
        highestPrice7dInSol = 1 / pool.week.priceMin;
        highestPrice30dInSol = 1 / pool.month.priceMin;
      } else if (pool.mintB.address === "So11111111111111111111111111111111111111112") {
        solLiquidity = pool.mintAmountB;
        tokenInfo = pool.mintA;
        priceInSol = pool.price;
        volume24h = pool.day.volume * solPriceUsd;
        highestPrice24hInSol = pool.day.priceMax;
        highestPrice7dInSol = pool.week.priceMax;
        highestPrice30dInSol = pool.month.priceMax;
      }

      if (solLiquidity < 100) {
        lowLiquidityCount++;
        continue;
      }

      if (tokenInfo && !processedTokens.has(tokenInfo.address)) {
        pageTokens.push({
          pool,
          tokenInfo,
          solLiquidity,
          priceInSol,
          volume24h,
          highestPrice24hInSol,
          highestPrice7dInSol,
          highestPrice30dInSol,
        });
      }
    }

    // Batch get account info
    const addresses = pageTokens.map((t) => t.tokenInfo.address);
    const accountInfos = await batchGetAccountInfo(connection, addresses);

    // Process results
    pageTokens.forEach((tokenData, index) => {
      const mintAccountInfo = accountInfos[index];
      const creationDate = mintAccountInfo ? mintAccountInfo.rentEpoch : undefined;

      const priceInUsd = tokenData.priceInSol * solPriceUsd;
      const highestPrice24h = tokenData.highestPrice24hInSol * solPriceUsd;
      const highestPrice7d = tokenData.highestPrice7dInSol * solPriceUsd;
      const highestPrice30d = tokenData.highestPrice30dInSol * solPriceUsd;
      const allTimeHighPrice = Math.max(highestPrice24h, highestPrice7d, highestPrice30d);

      tokensWithLiquidity.push({
        address: tokenData.tokenInfo.address,
        symbol: tokenData.tokenInfo.symbol,
        name: tokenData.tokenInfo.name,
        solLiquidity: tokenData.solLiquidity,
        poolId: tokenData.pool.id,
        priceInSol: tokenData.priceInSol,
        priceInUsd: priceInUsd,
        volume24h: tokenData.volume24h,
        highestPrice24h: highestPrice24h,
        highestPrice7d: highestPrice7d,
        highestPrice30d: highestPrice30d,
        allTimeHighPrice: allTimeHighPrice,
        timestamp: scriptTimestamp,
      });

      processedTokens.add(tokenData.tokenInfo.address);
    });

    hasNextPage = poolList.hasNextPage;
    page++;
    console.log(`Processed page ${page - 1}, hasNextPage: ${hasNextPage}, lowLiquidityCount: ${lowLiquidityCount}`);
  }

  console.log(`Total tokens with liquidity: ${tokensWithLiquidity.length}`);

  // Sort tokens by SOL liquidity in descending order
  tokensWithLiquidity.sort((a, b) => b.solLiquidity - a.solLiquidity);

  // Calculate price changes
  const priceChanges: PriceChange[] = [];
  const volumeChanges: VolumeChange[] = [];
  let allPricesUnchanged = true;

  for (const newToken of tokensWithLiquidity) {
    const oldToken = existingTokens.find((t) => t.address === newToken.address);
    if (oldToken) {
      const percentChange = ((newToken.priceInUsd - oldToken.priceInUsd) / oldToken.priceInUsd) * 100;
      priceChanges.push({
        symbol: newToken.symbol,
        name: newToken.name,
        address: newToken.address,
        oldPriceUsd: oldToken.priceInUsd,
        newPriceUsd: newToken.priceInUsd,
        percentChange: percentChange,
        solLiquidity: newToken.solLiquidity,
      });

      if (Math.abs(percentChange) > 0.000001) {
        allPricesUnchanged = false;
      }

      // Calculate volume change
      const volumePercentChange = ((newToken.volume24h - oldToken.volume24h) / oldToken.volume24h) * 100;
      volumeChanges.push({
        symbol: newToken.symbol,
        name: newToken.name,
        address: newToken.address,
        oldVolume: oldToken.volume24h,
        newVolume: newToken.volume24h,
        percentChange: volumePercentChange,
        solLiquidity: newToken.solLiquidity,
      });
    }
  }

  if (allPricesUnchanged) {
    console.log("\nWARNING: All token prices are unchanged since the last run.");
    console.log("Consider using Jupiter's API for more frequent price updates.");
  } else {
    // Sort price changes
    priceChanges.sort((a, b) => b.percentChange - a.percentChange);

    // Log top 10 price increases
    console.log("\nTop 10 price increases:");
    priceChanges.slice(0, 10).forEach((change, index) => {
      console.log(
        `${index + 1}. ${change.symbol} (${change.name}): ${change.percentChange.toFixed(
          2,
        )}% ($${change.oldPriceUsd.toFixed(6)} -> $${change.newPriceUsd.toFixed(6)})  :  ${
          change.address
        }  :  ${change.solLiquidity.toFixed(4)}`,
      );
    });

    // Log top 10 price decreases
    console.log("\nTop 10 price decreases:");
    priceChanges
      .slice(-10)
      .reverse()
      .forEach((change, index) => {
        console.log(
          `${index + 1}. ${change.symbol} (${change.name}): ${change.percentChange.toFixed(
            2,
          )}% ($${change.oldPriceUsd.toFixed(6)} -> $${change.newPriceUsd.toFixed(6)})  :  ${
            change.address
          }  :  ${change.solLiquidity.toFixed(4)}`,
        );
      });
  }

  function cleanupOldFiles() {
    try {
      const files = fs
        .readdirSync(outputFolder)
        .filter((file) => file.endsWith(".json") || file.endsWith(".txt"))
        .map((file) => ({
          name: file,
          path: path.join(outputFolder, file),
          time: fs.statSync(path.join(outputFolder, file)).mtime.getTime(),
        }))
        .sort((a, b) => b.time - a.time); // Sort newest to oldest

      // Keep only the newest 300 files (150 pairs of .json and .txt)
      const filesToDelete = files.slice(300);

      // Delete older files
      filesToDelete.forEach((file) => {
        try {
          fs.unlinkSync(file.path);
          console.log(`Deleted old file: ${file.name}`);
        } catch (err) {
          console.error(`Error deleting file ${file.name}:`, err);
        }
      });

      // Delete files older than 24 hours
      const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
      files.forEach((file) => {
        if (file.time < twentyFourHoursAgo) {
          try {
            fs.unlinkSync(file.path);
            console.log(`Deleted file older than 24 hours: ${file.name}`);
          } catch (err) {
            console.error(`Error deleting old file ${file.name}:`, err);
          }
        }
      });
    } catch (error) {
      console.error("Error during file cleanup:", error);
    }
  }

  // Run cleanup before writing new files
  cleanupOldFiles();

  const jsonFilePath = path.join(outputFolder, `raydium_tokens_with_liquidity_${runNumber}.json`);
  fs.writeFileSync(jsonFilePath, JSON.stringify(tokensWithLiquidity, null, 2));
  console.log(`Found ${tokensWithLiquidity.length} tokens with liquidity >= 100 SOL. Data saved to ${jsonFilePath}`);
}

console.log("Starting script");
main().catch((error) => {
  console.error("An error occurred:", error);
});
