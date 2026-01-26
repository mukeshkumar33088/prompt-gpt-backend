const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase
try {
    let serviceAccount;
    // Check if key exists locally (Development)
    if (require('fs').existsSync('./serviceAccountKey.json')) {
        serviceAccount = require('./serviceAccountKey.json');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Production (Render Env Var)
        // Check if it's base64 or raw JSON
        const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (rawKey.trim().startsWith('{')) {
            serviceAccount = JSON.parse(rawKey);
        } else {
            // Assume Base64
            const buffer = Buffer.from(rawKey, 'base64');
            serviceAccount = JSON.parse(buffer.toString('utf8'));
        }
    }

    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("Firebase Admin Initialized Successfully");
    } else {
        console.error("Firebase Service Account Key NOT FOUND. Limits will not work permanently.");
    }
} catch (e) {
    console.error("Firebase Init Error:", e);
}

const db = admin.firestore();
const DAILY_LIMIT = 5;

function getTodayStr() {
    return new Date().toISOString().split('T')[0];
}

async function getLimitStatus(deviceId, userEmail = null, userPhone = null) {
    if (!deviceId) return { allowed: false, remaining: 0, error: "No Device ID" };

    try {
        const userRef = db.collection('users').doc(deviceId);
        const doc = await userRef.get();
        const today = getTodayStr();

        let userData = doc.exists ? doc.data() : null;

        // Initialize or reset if new day
        if (!userData || userData.date !== today) {
            userData = {
                date: today,
                count: DAILY_LIMIT,
                ...userData // Keep existing fields like subscriptionExpiry
            };
            if (userData.subscriptionExpiry) delete userData.count; // Optimization: Don't need count for premium

            // Only update date/count, preserve premium info
            await userRef.set({ date: today, count: DAILY_LIMIT }, { merge: true });
        }

        // Check Premium via Expiry Date
        if (userData.subscriptionExpiry) {
            const expiryDate = new Date(userData.subscriptionExpiry);
            const now = new Date();

            if (expiryDate > now) {
                // VERIFY OWNERSHIP:
                // If Premium is linked to Email or Phone, requester MUST match one of them.

                let isMatch = false;
                let hasOwnerInfo = false;

                if (userData.email) {
                    hasOwnerInfo = true;
                    if (userEmail && userData.email.toLowerCase() === userEmail.toLowerCase()) {
                        isMatch = true;
                    }
                }

                if (userData.phone) {
                    hasOwnerInfo = true;
                    // Phone formats can vary (+91..., 98...), simple includes check or strict check
                    // Ideally sanitize both. For now assuming similar formats from Firebase
                    if (userPhone && (userData.phone === userPhone || userPhone.includes(userData.phone) || userData.phone.includes(userPhone))) {
                        isMatch = true;
                    }
                }

                // If owner info exists but NO match found -> DENY
                if (hasOwnerInfo && !isMatch) {
                    console.log(`[Limit] Premium mismatch. Owner: ${userData.email}/${userData.phone}, Requester: ${userEmail}/${userPhone}.`);

                    // Special Case: New device login for legitimate owner?
                    // Current logic: We rely on deviceId. The issue is "Shared Device".
                    // If User B (Free) uses Device 1 (Premium of User A), User B should be Free.
                    // So DENY is correct.

                    return {
                        allowed: userData.count > 0,
                        remaining: userData.count,
                        isPremium: false
                    };
                }

                return {
                    allowed: true,
                    remaining: 9999,
                    isPremium: true,
                    expiryDate: userData.subscriptionExpiry
                };
            }
        }

        return {
            allowed: userData.count > 0,
            remaining: userData.count,
            isPremium: false
        };
    } catch (e) {
        console.error("Error getting limit status:", e);
        // Fallback to allow if DB fails? No, fail safe.
        return { allowed: false, remaining: 0, error: "Database Error" };
    }
}

async function decrementLimit(deviceId) {
    try {
        const userRef = db.collection('users').doc(deviceId);
        // Transaction to ensure atomic update
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) return;
            const data = doc.data();

            // Validate again inside transaction
            if (data.subscriptionExpiry && new Date(data.subscriptionExpiry) > new Date()) {
                return; // Premium, don't decrement
            }

            if (data.count > 0) {
                t.update(userRef, { count: data.count - 1 });
            }
        });
        return true;
    } catch (e) {
        console.error("Error decrementing:", e);
        return false;
    }
}

async function incrementLimit(deviceId) {
    try {
        const userRef = db.collection('users').doc(deviceId);
        await userRef.update({ count: admin.firestore.FieldValue.increment(1) });
        return { success: true };
    } catch (e) {
        console.error("Error incrementing:", e);
        return { success: false };
    }
}

async function upgradeUser(deviceId, days = 30, paymentDetails = {}) {
    try {
        const userRef = db.collection('users').doc(deviceId);
        const doc = await userRef.get();

        const now = new Date();
        let currentExpiry = now;

        if (doc.exists) {
            const data = doc.data();
            if (data.subscriptionExpiry) {
                const exp = new Date(data.subscriptionExpiry);
                if (exp > now) currentExpiry = exp;
            }
        }

        // Add days
        currentExpiry.setDate(currentExpiry.getDate() + days);

        // Update users collection
        await userRef.set({
            subscriptionExpiry: currentExpiry.toISOString(),
            isPremium: true
        }, { merge: true });

        // Also add to premium_users collection for tracking
        const premiumUserRef = db.collection('premium_users').doc(deviceId);
        await premiumUserRef.set({
            deviceId: deviceId,
            subscriptionExpiry: currentExpiry.toISOString(),
            isPremium: true,
            upgradedAt: now.toISOString(),
            planDuration: days,
            email: paymentDetails.email || null,
            phone: paymentDetails.phone || null,
            orderId: paymentDetails.orderId || null,
            paymentId: paymentDetails.paymentId || null,
            amount: paymentDetails.amount || null,
        }, { merge: true });

        console.log(`User ${deviceId} upgraded to Premium. Expiry: ${currentExpiry.toISOString()}`);
        return true;
    } catch (e) {
        console.error("Error upgrading user:", e);
        return false;
    }
}

module.exports = {
    getLimitStatus,
    decrementLimit,
    incrementLimit,
    upgradeUser
};
