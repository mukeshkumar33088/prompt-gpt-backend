const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'limits.json');
const DAILY_LIMIT = 5;

// Initial data structure
let limitsData = {};

// Load data on startup
if (fs.existsSync(DATA_FILE)) {
    try {
        limitsData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        console.error("Error reading limits file:", e);
        limitsData = {};
    }
}

function saveLimits() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(limitsData, null, 2));
    } catch (e) {
        console.error("Error saving limits:", e);
    }
}

function getTodayStr() {
    return new Date().toISOString().split('T')[0];
}

function getLimitStatus(deviceId) {
    if (!deviceId) return { allowed: false, remaining: 0, error: "No Device ID" };

    const today = getTodayStr();
    let userData = limitsData[deviceId];

    // Initialize or reset if new day
    if (!userData || userData.date !== today) {
        userData = {
            date: today,
            count: DAILY_LIMIT
        };
        limitsData[deviceId] = userData;
        saveLimits();
    }

    // Check Premium via Expiry Date
    if (userData.subscriptionExpiry) {
        const expiryDate = new Date(userData.subscriptionExpiry);
        const now = new Date();

        if (expiryDate > now) {
            return {
                allowed: true,
                remaining: 9999,
                isPremium: true,
                expiryDate: userData.subscriptionExpiry
            };
        } else {
            // Expired
            userData.isPremium = false; // Cleanup old flag if present
            // Don't remove expiry date record, just treat as standard
        }
    }

    return {
        allowed: userData.count > 0,
        remaining: userData.count,
        isPremium: false
    };
}

function decrementLimit(deviceId) {
    const status = getLimitStatus(deviceId);
    // If premium (expiry > now), we don't decrement count? Or we do but it doesn't matter?
    // Usually premium is unlimited. So if allowed=true and remaing=9999, we skip decrement.

    if (status.isPremium) return true;

    if (status.allowed) {
        limitsData[deviceId].count--;
        saveLimits();
        return true;
    }
    return false;
}

function incrementLimit(deviceId) {
    const status = getLimitStatus(deviceId);
    if (limitsData[deviceId]) {
        limitsData[deviceId].count++;
        saveLimits();
        return { success: true, remaining: limitsData[deviceId].count };
    }
    return { success: false, error: "Device not found" };
}

function upgradeUser(deviceId, days = 30) {
    const status = getLimitStatus(deviceId); // Ensure entry exists
    if (limitsData[deviceId]) {
        const now = new Date();
        let currentExpiry = limitsData[deviceId].subscriptionExpiry ? new Date(limitsData[deviceId].subscriptionExpiry) : now;

        // If expired, start from now. If active, extend from current expiry.
        if (currentExpiry < now) {
            currentExpiry = now;
        }

        // Add days
        currentExpiry.setDate(currentExpiry.getDate() + days);

        limitsData[deviceId].subscriptionExpiry = currentExpiry.toISOString();
        limitsData[deviceId].isPremium = true; // Legacy flag support
        saveLimits();
        return true;
    }
    return false;
}

module.exports = {
    getLimitStatus,
    decrementLimit,
    incrementLimit,
    upgradeUser
};
