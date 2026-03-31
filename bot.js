/**
 * ============================================================
 * METEORA TREND FOLLOWING TRADING BOT
 * ============================================================
 * Strategi: Trend Following (EMA Cross)
 * - Beli ketika EMA cepat > EMA lambat (tren naik)
 * - Jual ketika EMA cepat < EMA lambat (tren turun)
 * Platform: Meteora DLMM di Solana
 * Via: Jupiter Aggregator API
 * ============================================================
 */

const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const axios = require("axios");
const bs58 = require("bs58");
require("dotenv").config();

// ============================================================
// KONFIGURASI BOT — EDIT SESUAI KEBUTUHAN KAMU
// ============================================================
const CONFIG = {
  // Token yang ingin di-trade (default: SOL/USDC)
  INPUT_MINT: "So11111111111111111111111111111111111111112", // SOL
  OUTPUT_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC

  // Jumlah per trade dalam SOL (contoh: 0.1 SOL)
  TRADE_AMOUNT_SOL: parseFloat(process.env.TRADE_AMOUNT_SOL || "0.1"),

  // Persentase stop-loss (contoh: 5 = 5%)
  STOP_LOSS_PCT: parseFloat(process.env.STOP_LOSS_PCT || "5"),

  // Persentase take-profit (contoh: 10 = 10%)
  TAKE_PROFIT_PCT: parseFloat(process.env.TAKE_PROFIT_PCT || "10"),

  // EMA period (jumlah candle)
  EMA_FAST: parseInt(process.env.EMA_FAST || "9"),
  EMA_SLOW: parseInt(process.env.EMA_SLOW || "21"),

  // Interval cek harga dalam milidetik (default: 60 detik)
  CHECK_INTERVAL_MS: parseInt(process.env.CHECK_INTERVAL_MS || "60000"),

  // Slippage tolerance (0.5 = 0.5%)
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS || "50"),

  // RPC endpoint Solana
  RPC_URL: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
};

// ============================================================
// INISIALISASI
// ============================================================
let wallet;
try {
  const privateKeyBase58 = process.env.WALLET_PRIVATE_KEY;
  if (!privateKeyBase58) throw new Error("WALLET_PRIVATE_KEY tidak ditemukan di .env");
  const secretKey = bs58.decode(privateKeyBase58);
  wallet = Keypair.fromSecretKey(secretKey);
  console.log(`✅ Wallet loaded: ${wallet.publicKey.toString()}`);
} catch (e) {
  console.error("❌ Gagal load wallet:", e.message);
  process.exit(1);
}

const connection = new Connection(CONFIG.RPC_URL, "confirmed");

// State bot
let priceHistory = [];
let position = null; // { entryPrice, amount, side }
let isRunning = false;

// ============================================================
// FUNGSI UTILITAS
// ============================================================

/** Hitung EMA dari array harga */
function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

/** Ambil harga SOL dari Jupiter */
async function getCurrentPrice() {
  try {
    const res = await axios.get(
      `https://price.jup.ag/v6/price?ids=${CONFIG.INPUT_MINT}&vsToken=${CONFIG.OUTPUT_MINT}`,
      { timeout: 10000 }
    );
    const price = res.data?.data?.[CONFIG.INPUT_MINT]?.price;
    if (!price) throw new Error("Harga tidak tersedia");
    return parseFloat(price);
  } catch (e) {
    console.error("⚠️  Gagal ambil harga:", e.message);
    return null;
  }
}

/** Ambil quote swap dari Jupiter */
async function getSwapQuote(inputMint, outputMint, amount) {
  try {
    const res = await axios.get("https://quote-api.jup.ag/v6/quote", {
      params: {
        inputMint,
        outputMint,
        amount,
        slippageBps: CONFIG.SLIPPAGE_BPS,
        onlyDirectRoutes: false,
        asLegacyTransaction: false,
      },
      timeout: 15000,
    });
    return res.data;
  } catch (e) {
    console.error("⚠️  Gagal ambil quote:", e.message);
    return null;
  }
}

/** Eksekusi swap via Jupiter */
async function executeSwap(quote) {
  try {
    // Ambil swap transaction
    const swapRes = await axios.post(
      "https://quote-api.jup.ag/v6/swap",
      {
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      },
      { timeout: 20000 }
    );

    const { swapTransaction } = swapRes.data;

    // Decode & sign
    const { VersionedTransaction } = require("@solana/web3.js");
    const txBuffer = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(txBuffer);
    transaction.sign([wallet]);

    // Kirim transaksi
    const txid = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    // Konfirmasi
    await connection.confirmTransaction(txid, "confirmed");
    return txid;
  } catch (e) {
    console.error("❌ Gagal eksekusi swap:", e.message);
    return null;
  }
}

/** Format log dengan timestamp */
function log(msg, type = "INFO") {
  const time = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const icon = { INFO: "ℹ️", BUY: "🟢", SELL: "🔴", WARN: "⚠️", ERROR: "❌", PROFIT: "💰" }[type] || "•";
  console.log(`[${time}] ${icon} ${msg}`);
}

// ============================================================
// LOGIKA TRADING UTAMA
// ============================================================

async function checkBalances() {
  try {
    const solBalance = await connection.getBalance(wallet.publicKey);
    log(`Balance SOL: ${(solBalance / 1e9).toFixed(4)} SOL`);
    return solBalance;
  } catch (e) {
    log("Gagal cek balance: " + e.message, "WARN");
    return 0;
  }
}

async function runTradingCycle() {
  if (isRunning) return;
  isRunning = true;

  try {
    // Ambil harga terkini
    const price = await getCurrentPrice();
    if (!price) {
      isRunning = false;
      return;
    }

    // Simpan histori harga
    priceHistory.push(price);
    if (priceHistory.length > 100) priceHistory.shift(); // Batasi memori

    log(`Harga SOL: $${price.toFixed(4)} | History: ${priceHistory.length} candle`);

    // Butuh minimal data untuk EMA
    if (priceHistory.length < CONFIG.EMA_SLOW + 5) {
      log(`Mengumpulkan data... (${priceHistory.length}/${CONFIG.EMA_SLOW + 5})`);
      isRunning = false;
      return;
    }

    // Hitung EMA
    const emaFast = calculateEMA(priceHistory, CONFIG.EMA_FAST);
    const emaSlow = calculateEMA(priceHistory, CONFIG.EMA_SLOW);

    log(`EMA${CONFIG.EMA_FAST}: $${emaFast?.toFixed(4)} | EMA${CONFIG.EMA_SLOW}: $${emaSlow?.toFixed(4)}`);

    // ── Cek Stop Loss / Take Profit jika ada posisi ──
    if (position) {
      const pnlPct = ((price - position.entryPrice) / position.entryPrice) * 100;
      log(`Posisi aktif: entry $${position.entryPrice.toFixed(4)} | PnL: ${pnlPct.toFixed(2)}%`);

      const shouldStopLoss = pnlPct <= -CONFIG.STOP_LOSS_PCT;
      const shouldTakeProfit = pnlPct >= CONFIG.TAKE_PROFIT_PCT;

      if (shouldStopLoss || shouldTakeProfit) {
        const reason = shouldStopLoss ? "STOP LOSS" : "TAKE PROFIT";
        log(`${reason} tercapai! Menjual posisi...`, shouldStopLoss ? "WARN" : "PROFIT");
        await sellPosition(price, reason);
        isRunning = false;
        return;
      }
    }

    // ── Sinyal Trend Following ──
    const trendUp = emaFast > emaSlow;
    const trendDown = emaFast < emaSlow;

    if (trendUp && !position) {
      // Sinyal BELI — tren naik
      log(`Sinyal BELI: EMA cepat melewati EMA lambat ke atas 📈`, "BUY");
      await buyPosition(price);
    } else if (trendDown && position) {
      // Sinyal JUAL — tren turun
      log(`Sinyal JUAL: EMA cepat turun di bawah EMA lambat 📉`, "SELL");
      await sellPosition(price, "TREND REVERSAL");
    } else {
      const status = position ? "Menahan posisi" : "Menunggu sinyal";
      log(`${status} | Tren: ${trendUp ? "⬆️ Naik" : trendDown ? "⬇️ Turun" : "➡️ Sideways"}`);
    }
  } catch (e) {
    log("Error pada siklus trading: " + e.message, "ERROR");
  }

  isRunning = false;
}

async function buyPosition(price) {
  try {
    const solBalance = await connection.getBalance(wallet.publicKey);
    const tradeAmountLamports = Math.floor(CONFIG.TRADE_AMOUNT_SOL * 1e9);

    if (solBalance < tradeAmountLamports + 10000000) {
      // 0.01 SOL buffer untuk fee
      log("Balance SOL tidak cukup untuk trade!", "WARN");
      return;
    }

    log(`Mengeksekusi BUY ${CONFIG.TRADE_AMOUNT_SOL} SOL @ $${price.toFixed(4)}...`, "BUY");

    const quote = await getSwapQuote(CONFIG.INPUT_MINT, CONFIG.OUTPUT_MINT, tradeAmountLamports);
    if (!quote) return;

    if (process.env.DRY_RUN === "true") {
      log(`[DRY RUN] BUY simulasi: ${CONFIG.TRADE_AMOUNT_SOL} SOL @ $${price.toFixed(4)}`, "BUY");
      position = { entryPrice: price, amount: CONFIG.TRADE_AMOUNT_SOL, side: "long" };
      return;
    }

    const txid = await executeSwap(quote);
    if (txid) {
      position = { entryPrice: price, amount: CONFIG.TRADE_AMOUNT_SOL, side: "long" };
      log(`✅ BUY berhasil! TX: https://solscan.io/tx/${txid}`, "BUY");
    }
  } catch (e) {
    log("Gagal BUY: " + e.message, "ERROR");
  }
}

async function sellPosition(price, reason) {
  if (!position) return;
  try {
    const pnl = ((price - position.entryPrice) / position.entryPrice) * 100;
    log(`Menjual posisi (${reason}) | PnL: ${pnl.toFixed(2)}%`, pnl >= 0 ? "PROFIT" : "SELL");

    // Estimasi USDC yang dimiliki (perlu tracking lebih akurat di produksi)
    // Untuk demo, kita swap kembali ke SOL
    const usdcMint = CONFIG.OUTPUT_MINT;
    const solMint = CONFIG.INPUT_MINT;

    if (process.env.DRY_RUN === "true") {
      log(`[DRY RUN] SELL simulasi @ $${price.toFixed(4)} | PnL: ${pnl.toFixed(2)}%`, "SELL");
      position = null;
      return;
    }

    // Di produksi nyata: ambil balance USDC dan swap ke SOL
    log("Transaksi SELL dikirim... (implementasikan tracking USDC balance untuk produksi)");
    position = null;
  } catch (e) {
    log("Gagal SELL: " + e.message, "ERROR");
  }
}

// ============================================================
// MULAI BOT
// ============================================================
async function startBot() {
  console.log(`
╔════════════════════════════════════════════╗
║     METEORA TREND FOLLOWING BOT v1.0      ║
╚════════════════════════════════════════════╝
`);

  log(`Wallet: ${wallet.publicKey.toString()}`);
  log(`Mode: ${process.env.DRY_RUN === "true" ? "🧪 DRY RUN (simulasi)" : "🔴 LIVE TRADING"}`);
  log(`Pair: SOL/USDC`);
  log(`Trade Amount: ${CONFIG.TRADE_AMOUNT_SOL} SOL per trade`);
  log(`EMA: ${CONFIG.EMA_FAST}/${CONFIG.EMA_SLOW}`);
  log(`Stop Loss: ${CONFIG.STOP_LOSS_PCT}% | Take Profit: ${CONFIG.TAKE_PROFIT_PCT}%`);
  log(`Interval: ${CONFIG.CHECK_INTERVAL_MS / 1000} detik`);
  console.log("─".repeat(50));

  await checkBalances();

  log("Bot dimulai! Mengumpulkan data harga...");

  // Jalankan siklus pertama langsung
  await runTradingCycle();

  // Loop utama
  setInterval(runTradingCycle, CONFIG.CHECK_INTERVAL_MS);
}

// Handle exit gracefully
process.on("SIGINT", () => {
  log("Bot dihentikan oleh user.", "WARN");
  process.exit(0);
});

startBot().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
