/**
 * @fileoverview Express API server for interacting with the Compound cETH protocol.
 * This file demonstrates secure configuration loading, asynchronous initialization,
 * and dynamic transaction parameter calculation (gas estimation).
 * * IMPORTANT: This assumes 'config.json' contains cEthAddress and cEthAbi.
 */
const express = require('express');
const bodyParser = require('body-parser');
const Web3 = require('web3');
const config = require('./config.json');

// Ensure environment variables are loaded securely
require('dotenv').config();

// --- CONFIGURATION ---
const PORT = 3000;
const INFURA_API_KEY = process.env.INFURA_API_KEY; // Must be loaded from .env
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY; // Must be loaded from .env
const RPC_URL = `https://mainnet.infura.io/v3/${INFURA_API_KEY}`;

// Constants for cToken (usually 8 decimals for Compound cTokens)
const C_TOKEN_DECIMALS = 8; 
const C_TOKEN_UNIT = Web3.utils.toBN(10).pow(Web3.utils.toBN(C_TOKEN_DECIMALS));

// --- GLOBAL VARIABLES (Initialized in init()) ---
let web3;
let myWalletAddress;
let cEthContract;

/**
 * Handles synchronous server setup and starts listening.
 */
function startServer() {
    const app = express();
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));

    // --- API ROUTES ---

    // GET /protocol-balance/eth/ - Fetches the user's underlying ETH balance supplied to Compound.
    app.route('/protocol-balance/eth/').get(async (req, res) => {
        try {
            const result = await cEthContract.methods.balanceOfUnderlying(myWalletAddress).call();
            // Convert result from Wei (18 decimals) to Ether
            const balanceOfUnderlying = web3.utils.fromWei(result, 'ether');
            return res.send(balanceOfUnderlying);
        } catch (error) {
            console.error('[protocol-balance] error:', error);
            // Send a client error response
            return res.status(500).send({ error: 'Failed to fetch underlying balance.' }); 
        }
    });

    // GET /wallet-balance/eth/ - Fetches the user's raw ETH balance in their wallet.
    app.route('/wallet-balance/eth/').get(async (req, res) => {
        try {
            const result = await web3.eth.getBalance(myWalletAddress);
            const ethBalance = web3.utils.fromWei(result, 'ether');
            return res.send(ethBalance);
        } catch (error) {
            console.error('[wallet-balance] error:', error);
            return res.status(500).send({ error: 'Failed to fetch wallet balance.' });
        }
    });

    // GET /wallet-balance/ceth/ - Fetches the user's cETH balance (cTokens).
    app.route('/wallet-balance/ceth/').get(async (req, res) => {
        try {
            const result = await cEthContract.methods.balanceOf(myWalletAddress).call();
            // Calculate cToken balance using BigNumber and cToken decimals (8)
            const cTokenBalance = Web3.utils.toBN(result).div(C_TOKEN_UNIT).toString();
            return res.send(cTokenBalance);
        } catch (error) {
            console.error('[wallet-ctoken-balance] error:', error);
            return res.status(500).send({ error: 'Failed to fetch cToken balance.' });
        }
    });

    // GET /supply/eth/:amount - Deposits ETH into Compound (calls mint()).
    app.route('/supply/eth/:amount').get(async (req, res) => {
        const amountStr = req.params.amount;
        if (isNaN(amountStr) || parseFloat(amountStr) <= 0) {
            return res.status(400).send({ error: 'Invalid or missing amount.' });
        }

        try {
            const valueWei = web3.utils.toWei(amountStr, 'ether');
            
            // FIX: Fetch current gas price dynamically
            const gasPrice = await web3.eth.getGasPrice(); 
            
            // NOTE: Using a hardcoded gas limit (500,000) is okay for cETH minting, 
            // but gas estimation (estimateGas) is generally preferred.
            
            const transaction = cEthContract.methods.mint().send({
                from: myWalletAddress,
                gas: web3.utils.toHex(500000), 
                gasPrice: web3.utils.toHex(gasPrice), // Use fetched dynamic price
                value: valueWei // Value is now correct Wei string/BigNumber
            });

            await transaction;
            return res.status(200).send({ success: true, message: `Successfully supplied ${amountStr} ETH.` });
        } catch (error) {
            console.error('[supply] error:', error.message);
            // Send detailed error message back for debugging
            return res.status(500).send({ error: 'Transaction failed during minting.', details: error.message });
        }
    });

    // GET /redeem/eth/:cTokenAmount - Withdraws ETH from Compound (calls redeem()).
    app.route('/redeem/eth/:cTokenAmount').get(async (req, res) => {
        const cTokenAmountStr = req.params.cTokenAmount;
        if (isNaN(cTokenAmountStr) || parseFloat(cTokenAmountStr) <= 0) {
            return res.status(400).send({ error: 'Invalid cToken amount.' });
        }
        
        try {
            // FIX: Convert cToken amount string to correct BigNumber representation (8 decimals)
            const redeemAmount = Web3.utils.toBN(cTokenAmountStr).mul(C_TOKEN_UNIT);
            
            // FIX: Fetch current gas price dynamically
            const gasPrice = await web3.eth.getGasPrice(); 
            
            const transaction = cEthContract.methods.redeem(redeemAmount.toString()).send({
                from: myWalletAddress,
                gas: web3.utils.toHex(500000),
                gasPrice: web3.utils.toHex(gasPrice)
            });

            await transaction;
            return res.status(200).send({ success: true, message: `Successfully redeemed ${cTokenAmountStr} cETH.` });
        } catch (error) {
            console.error('[redeem] error:', error.message);
            return res.status(500).send({ error: 'Transaction failed during redemption.', details: error.message });
        }
    });

    app.listen(PORT, () => console.log(`API server running on port ${PORT}. Wallet: ${myWalletAddress}`));
}

/**
 * Main initialization function.
 */
async function init() {
    if (!INFURA_API_KEY || INFURA_API_KEY === '_your_api_key_here_' || !WALLET_PRIVATE_KEY) {
        console.error("CRITICAL ERROR: Please set INFURA_API_KEY and WALLET_PRIVATE_KEY in your .env file.");
        process.exit(1);
    }
    
    try {
        // Initialize Web3 and connect
        web3 = new Web3(RPC_URL);
        
        // Add wallet account
        web3.eth.accounts.wallet.add(WALLET_PRIVATE_KEY);
        myWalletAddress = web3.eth.accounts.wallet[0].address;

        // Initialize cETH Contract
        cEthContract = new web3.eth.Contract(config.cEthAbi, config.cEthAddress);

        console.log(`Web3 initialized successfully. Connected to ${RPC_URL}`);
        
        // Start the Express server only after successful Web3 setup
        startServer();
        
    } catch (error) {
        console.error("CRITICAL ERROR during Web3 initialization or connection:", error);
        process.exit(1);
    }
}

init();
