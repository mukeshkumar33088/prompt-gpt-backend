const Razorpay = require('razorpay');
const crypto = require('crypto');
require('dotenv').config(); // Ensure env is loaded even if called separately or if inheritance fails

// Initialize Razorpay
// TODO: Replace with real keys from .env
const instance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder',
});

async function createOrder(amount) {
    // Validation
    console.log("Creating Order with Key:", process.env.RAZORPAY_KEY_ID ? "Found" : "Missing");
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        throw new Error("Razorpay Keys are missing in backend .env");
    }

    // Force Real Order Creation
    const options = {
        amount: amount * 100, // Amount in paise
        currency: "INR",
        receipt: "receipt#" + Date.now(),
    };
    try {
        const order = await instance.orders.create(options);
        return order;
    } catch (error) {
        console.error("Razorpay Order Error Details:", JSON.stringify(error, null, 2));
        throw error;
    }
}

function verifyPayment(orderId, paymentId, signature) {
    if (orderId.startsWith("order_mock_")) return true;

    const text = orderId + "|" + paymentId;
    const generated_signature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder')
        .update(text.toString())
        .digest('hex');

    if (generated_signature === signature) {
        return true;
    }
    return false;
}

module.exports = {
    createOrder,
    verifyPayment
};
