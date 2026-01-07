# M-Pesa Integration Guide

## Overview

This guide will help you set up Lipa na M-Pesa (STK Push) integration in your application.

## 📋 Prerequisites

1. **Safaricom Daraja Account**

   - Visit [Safaricom Daraja Portal](https://developer.safaricom.co.ke)
   - Create an account and log in

2. **Create a Daraja App**

   - Go to "My Apps" → "Create New App"
   - Select "Lipa Na M-Pesa Online"
   - Note down your **Consumer Key** and **Consumer Secret**

3. **Get Your Credentials**
   - **Consumer Key**: From your Daraja app
   - **Consumer Secret**: From your Daraja app
   - **Passkey**: From Daraja (Test Credentials section for sandbox)
   - **Business Short Code**: Your paybill/till number
   - **Callback URL**: Must be a publicly accessible HTTPS URL

## 🚀 Setup Instructions

### 1. Database Migration

Run the Prisma migration to create the M-Pesa transaction table:

```bash
npx prisma migrate dev --name add_mpesa_transactions
```

Or generate the Prisma client:

```bash
npx prisma generate
```

### 2. Environment Variables

Copy `.env.example` to `.env` and fill in your M-Pesa credentials:

```env
# M-Pesa Configuration
MPESA_CONSUMER_KEY=your_consumer_key_here
MPESA_CONSUMER_SECRET=your_consumer_secret_here
MPESA_PASSKEY=your_passkey_here
MPESA_SHORT_CODE=your_paybill_number
MPESA_CALLBACK_URL=https://your-domain.com/api/mpesa/callback
MPESA_ENVIRONMENT=sandbox  # or "production"
```

### 3. Callback URL Setup (Development)

For local development, you need to expose your localhost to the internet for M-Pesa callbacks.

#### Option A: Using ngrok (Recommended)

1. Install ngrok: https://ngrok.com/download
2. Run your server: `npm run dev`
3. In a new terminal, run: `ngrok http 8080`
4. Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)
5. Update your `.env`:
   ```env
   MPESA_CALLBACK_URL=https://abc123.ngrok.io/api/mpesa/callback
   ```
6. Register this URL in your Daraja app settings

#### Option B: Using localtunnel

```bash
npm install -g localtunnel
lt --port 8080
```

### 4. Test Credentials (Sandbox)

For testing in sandbox mode, use these test credentials from Safaricom:

- **Business Short Code**: `174379`
- **Passkey**: Get from Daraja portal test credentials
- **Test Phone**: `254708374149` (or your Safaricom test number)
- **Test Amount**: Any amount between 1-150000

## 🔌 API Endpoints

### 1. Initiate Payment (STK Push)

**POST** `/api/mpesa/initiate`

Request body:

```json
{
  "userId": "user_2abc123xyz",
  "phoneNumber": "254712345678",
  "amount": 100,
  "accountReference": "ROOM_PAYMENT"
}
```

Response:

```json
{
  "success": true,
  "message": "STK Push sent successfully. Please check your phone.",
  "data": {
    "transactionId": "uuid-here",
    "checkoutRequestId": "ws_CO_123456789",
    "merchantRequestId": "12345-67890-1"
  }
}
```

### 2. Check Transaction Status

**GET** `/api/mpesa/status/:transactionId`

Response:

```json
{
  "success": true,
  "data": {
    "id": "uuid-here",
    "userId": "user_2abc123xyz",
    "phoneNumber": "254712345678",
    "amount": "100.00",
    "accountReference": "ROOM_PAYMENT",
    "status": "SUCCESS",
    "mpesaReceiptNumber": "PGH7X8Y9Z0",
    "transactionDate": "2026-01-07T10:30:00Z",
    "resultCode": 0,
    "resultDesc": "The service request is processed successfully."
  }
}
```

### 3. Get Transaction History

**GET** `/api/mpesa/transactions/:userId?limit=20&offset=0`

Response:

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid-here",
      "amount": "100.00",
      "status": "SUCCESS",
      "mpesaReceiptNumber": "PGH7X8Y9Z0",
      "createdAt": "2026-01-07T10:30:00Z"
    }
  ]
}
```

### 4. M-Pesa Callback (Internal)

**POST** `/api/mpesa/callback`

This endpoint receives callbacks from Safaricom. Do not call this manually - it's automatically called by M-Pesa.

## 💻 Frontend Integration

### React Component Example

Copy the `MpesaPaymentModal.tsx` file to your frontend project and use it:

```tsx
import { MpesaPaymentModal } from "./components/MpesaPaymentModal";

function MyComponent() {
  const [showPayment, setShowPayment] = useState(false);
  const { userId } = useUser(); // From Clerk or your auth provider

  return (
    <>
      <button onClick={() => setShowPayment(true)}>💰 Pay with M-Pesa</button>

      {showPayment && (
        <MpesaPaymentModal
          userId={userId}
          onSuccess={(transactionId) => {
            console.log("Payment successful!", transactionId);
            // Refresh user credits, unlock features, etc.
            setShowPayment(false);
          }}
          onError={(error) => {
            console.error("Payment failed:", error);
          }}
          onClose={() => setShowPayment(false)}
        />
      )}
    </>
  );
}
```

### Plain JavaScript/Fetch Example

```javascript
async function initiatePayment(userId, phoneNumber, amount, account) {
  try {
    const response = await fetch("http://localhost:8080/api/mpesa/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        phoneNumber,
        amount,
        accountReference: account,
      }),
    });

    const data = await response.json();

    if (data.success) {
      alert("Check your phone for M-Pesa prompt!");
      // Poll for payment status
      checkPaymentStatus(data.data.transactionId);
    }
  } catch (error) {
    console.error("Payment error:", error);
  }
}

async function checkPaymentStatus(transactionId) {
  const response = await fetch(
    `http://localhost:8080/api/mpesa/status/${transactionId}`
  );
  const data = await response.json();

  if (data.data.status === "SUCCESS") {
    alert("Payment successful!");
  } else if (data.data.status === "PENDING") {
    // Check again after 5 seconds
    setTimeout(() => checkPaymentStatus(transactionId), 5000);
  }
}
```

## 🧪 Testing

### 1. Test with Sandbox

Use the sandbox environment and test phone numbers provided by Safaricom.

### 2. Test the Flow

1. Click the payment button
2. Enter a test phone number
3. Enter an amount (1-150000 for sandbox)
4. Select an account type
5. Click "Pay Now"
6. You should receive an STK Push prompt on your phone
7. Enter your M-Pesa PIN (1234 for test accounts)
8. Payment should complete and status update automatically

### 3. Check Logs

Monitor your server console for M-Pesa logs:

- ✅ Success indicators
- ❌ Error indicators
- 📲 Callback receipts

## 🔒 Security Best Practices

1. **Never expose credentials**: Keep your `.env` file secure and never commit it
2. **Use HTTPS**: M-Pesa only accepts HTTPS callback URLs in production
3. **Validate amounts**: Always validate amounts on the backend
4. **Check user identity**: Verify userId matches the authenticated user
5. **Log transactions**: All transactions are automatically logged in the database
6. **Handle duplicates**: The system uses unique checkout request IDs to prevent duplicates

## 🐛 Troubleshooting

### "Failed to get M-Pesa access token"

- Check your Consumer Key and Consumer Secret
- Verify your Daraja app is active
- Check internet connectivity

### "STK Push failed"

- Verify phone number format (254XXXXXXXXX)
- Check if shortcode is correct
- Ensure passkey is valid
- Verify callback URL is publicly accessible

### Callback not received

- Check ngrok/tunnel is running
- Verify callback URL in `.env` matches your tunnel URL
- Check Daraja portal callback URL registration
- Look for firewall/security blocks

### Payment shows PENDING forever

- User may not have completed payment on their phone
- Check M-Pesa server status
- Query transaction status manually: `/api/mpesa/status/:transactionId`

## 📱 Production Deployment

When deploying to production:

1. **Update Environment**: Change `MPESA_ENVIRONMENT=production`
2. **Get Production Credentials**: Request production API keys from Safaricom
3. **Register Production Callback**: Use your production domain
4. **Use Real Shortcode**: Your actual paybill/till number
5. **SSL Certificate**: Ensure your domain has valid HTTPS
6. **Go-Live Approval**: Submit go-live request in Daraja portal

## 📊 Database Schema

The `MpesaTransaction` model stores:

- User information
- Phone number and amount
- Transaction status (PENDING, SUCCESS, FAILED, CANCELLED)
- M-Pesa receipt number
- Merchant/checkout request IDs
- Result codes and descriptions
- Timestamps

## 🎯 Account Reference Types

Customize account types in your frontend:

```typescript
const accountOptions = [
  { value: "ROOM_PAYMENT", label: "Room Payment" },
  { value: "SUBSCRIPTION", label: "Subscription" },
  { value: "CREDITS", label: "Buy Credits" },
  { value: "DONATION", label: "Donation" },
  // Add your own types
];
```

## 📞 Support

- **Safaricom Support**: [Daraja Portal](https://developer.safaricom.co.ke)
- **Documentation**: [M-Pesa API Docs](https://developer.safaricom.co.ke/Documentation)

---

Happy coding! 🚀
