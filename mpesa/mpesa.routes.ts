import { Router, Request, Response } from "express";
import { prisma } from "../prisma";
import { mpesaService } from "./mpesa.service";

const router = Router();

// Test endpoint to verify callback URL is reachable
router.get("/callback-test", (req: Request, res: Response) => {
  res.json({
    success: true,
    message: "Callback endpoint is reachable",
    timestamp: new Date().toISOString(),
  });
});
/**
 * POST /api/mpesa/register-urls
 * Register callback URLs with Safaricom (C2B API)
 * This must be called to enable callbacks to work
 */
router.post("/register-urls", async (req: Request, res: Response) => {
  try {
    const baseUrl =
      process.env.MPESA_CALLBACK_URL?.replace("/api/mpesa/callback", "") ||
      "https://grace-server-production.up.railway.app";

    const validationUrl = `${baseUrl}/api/mpesa/validation`;
    const confirmationUrl = `${baseUrl}/api/mpesa/callback`;

    console.log(`📝 Registering URLs with Safaricom:
    - Validation: ${validationUrl}
    - Confirmation: ${confirmationUrl}`);

    const result = await mpesaService.registerC2BUrls(
      validationUrl,
      confirmationUrl
    );

    return res.status(200).json({
      success: true,
      message: "URLs registered successfully with Safaricom",
      data: result,
    });
  } catch (error: any) {
    console.error("❌ URL Registration Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to register URLs",
    });
  }
});

/**
 * POST /api/mpesa/validation
 * M-Pesa validation endpoint (required for C2B)
 */
router.post("/validation", (req: Request, res: Response) => {
  console.log(
    "✅ Validation request received:",
    JSON.stringify(req.body, null, 2)
  );
  // Accept all transactions
  res.status(200).json({
    ResultCode: 0,
    ResultDesc: "Accepted",
  });
});
// Temporary storage for pending transactions (before callback confirmation)
// In production, consider using Redis for distributed systems
const pendingTransactions = new Map<
  string,
  {
    userId: string;
    userName?: string;
    phoneNumber: string;
    amount: number;
    accountReference: string;
    merchantRequestId: string;
    initiatedAt: Date;
  }
>();

// Clean up old pending transactions (older than 5 minutes)
setInterval(() => {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  for (const [key, value] of pendingTransactions.entries()) {
    if (value.initiatedAt < fiveMinutesAgo) {
      pendingTransactions.delete(key);
      console.log(`🧹 Cleaned up expired pending transaction: ${key}`);
    }
  }
}, 60000); // Run every minute

/**
 * POST /api/mpesa/initiate
 * Initiate M-Pesa payment (STK Push)
 */
router.post("/initiate", async (req: Request, res: Response) => {
  try {
    const { userId, userName, phoneNumber, amount, accountReference } =
      req.body;

    // Validation
    if (!userId || !phoneNumber || !amount || !accountReference) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required fields: userId, phoneNumber, amount, accountReference",
      });
    }

    if (amount < 1) {
      return res.status(400).json({
        success: false,
        message: "Amount must be at least 1 KES",
      });
    }

    // Initiate STK Push
    const stkResponse = await mpesaService.stkPush(
      phoneNumber,
      amount,
      accountReference,
      `Payment for ${accountReference}`
    );

    // Store transaction details temporarily (not in DB yet)
    // Will be saved to DB only when Safaricom confirms payment via callback
    pendingTransactions.set(stkResponse.CheckoutRequestID, {
      userId,
      userName,
      phoneNumber,
      amount,
      accountReference,
      merchantRequestId: stkResponse.MerchantRequestID,
      initiatedAt: new Date(),
    });

    console.log(`📤 STK Push sent to ${phoneNumber} for KES ${amount}`);

    return res.status(200).json({
      success: true,
      message: "STK Push sent successfully. Please check your phone.",
      data: {
        checkoutRequestId: stkResponse.CheckoutRequestID,
        merchantRequestId: stkResponse.MerchantRequestID,
      },
    });
  } catch (error: any) {
    console.error("❌ M-Pesa Initiate Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to initiate payment",
    });
  }
});

/**
 * POST /api/mpesa/callback
 * M-Pesa callback handler
 */
router.post("/callback", async (req: Request, res: Response) => {
  try {
    console.log("=".repeat(60));
    console.log("📲 M-Pesa Callback Received at:", new Date().toISOString());
    console.log("📲 M-Pesa Callback Body:", JSON.stringify(req.body, null, 2));
    console.log("=".repeat(60));

    const { Body } = req.body;

    if (!Body || !Body.stkCallback) {
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
    }

    const {
      MerchantRequestID,
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
      CallbackMetadata,
    } = Body.stkCallback;

    // Get pending transaction details
    const pendingTxn = pendingTransactions.get(CheckoutRequestID);

    console.log(`🔍 Looking for pending transaction: ${CheckoutRequestID}`);
    console.log(
      `📦 Pending transactions map size: ${pendingTransactions.size}`
    );
    console.log(`📋 Pending transaction found:`, pendingTxn ? "YES" : "NO");

    if (!pendingTxn) {
      console.warn("⚠️ Pending transaction not found:", CheckoutRequestID);
      console.warn(
        "⚠️ Available transactions:",
        Array.from(pendingTransactions.keys())
      );
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
    }

    // Only save to database if payment was SUCCESSFUL
    if (ResultCode === 0) {
      // Success - Extract data from Safaricom callback
      const metadata = CallbackMetadata?.Item || [];
      const mpesaReceiptNumber = metadata.find(
        (item: any) => item.Name === "MpesaReceiptNumber"
      )?.Value;
      const transactionDate = metadata.find(
        (item: any) => item.Name === "TransactionDate"
      )?.Value;
      const mpesaPhoneNumber = metadata.find(
        (item: any) => item.Name === "PhoneNumber"
      )?.Value;
      const paidAmount = metadata.find(
        (item: any) => item.Name === "Amount"
      )?.Value;

      // Get name from Safaricom callback (if available)
      const firstNameItem = metadata.find(
        (item: any) => item.Name === "FirstName"
      );
      const lastNameItem = metadata.find(
        (item: any) => item.Name === "LastName"
      );
      const mpesaUserName =
        firstNameItem && lastNameItem
          ? `${firstNameItem.Value} ${lastNameItem.Value}`.trim()
          : firstNameItem?.Value || lastNameItem?.Value;

      // Create transaction record in database with Safaricom data
      const transaction = await prisma.mpesaTransaction.create({
        data: {
          userId: pendingTxn.userId,
          userName: pendingTxn.userName || mpesaUserName || null,
          phoneNumber: mpesaPhoneNumber || pendingTxn.phoneNumber,
          amount: paidAmount || pendingTxn.amount,
          accountReference: pendingTxn.accountReference,
          merchantRequestId: pendingTxn.merchantRequestId,
          checkoutRequestId: CheckoutRequestID,
          mpesaReceiptNumber,
          transactionDate: transactionDate
            ? new Date(String(transactionDate))
            : null,
          resultCode: ResultCode,
          resultDesc: ResultDesc,
          status: "SUCCESS",
        },
      });

      console.log(
        `✅ Payment Successful - Receipt: ${mpesaReceiptNumber}, Amount: KES ${paidAmount}, User: ${
          transaction.userName || "N/A"
        }`
      );
      console.log(`💾 Transaction saved to DB with ID: ${transaction.id}`);
    } else {
      // Failed or Cancelled - Just log, don't save to database
      const status = ResultCode === 1032 ? "CANCELLED" : "FAILED";
      console.log(
        `❌ Payment ${status} - User: ${pendingTxn.userId}, Amount: KES ${pendingTxn.amount}, Reason: ${ResultDesc}`
      );
    }

    // Remove from pending transactions
    pendingTransactions.delete(CheckoutRequestID);
    console.log(`🗑️ Removed ${CheckoutRequestID} from pending transactions`);

    return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (error: any) {
    console.error("❌ M-Pesa Callback Error:", error);
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  }
});

/**
 * GET /api/mpesa/status/:checkoutRequestId
 * Check payment status by checkout request ID
 */
router.get(
  "/status/:checkoutRequestId",
  async (req: Request, res: Response) => {
    try {
      const { checkoutRequestId } = req.params;
      console.log(`🔍 Status check for: ${checkoutRequestId}`);

      // First check if transaction exists in database (payment confirmed)
      const transaction = await prisma.mpesaTransaction.findUnique({
        where: { checkoutRequestId },
      });

      if (transaction) {
        // Transaction found in DB - payment was successful
        console.log(`✅ Found in DB - Status: SUCCESS`);
        return res.status(200).json({
          success: true,
          status: "SUCCESS",
          data: transaction,
        });
      }

      // Not in DB yet - check if still pending
      const pendingTxn = pendingTransactions.get(checkoutRequestId);

      if (pendingTxn) {
        // Query M-Pesa directly if no callback received after 30 seconds
        const timeSinceInitiation =
          Date.now() - pendingTxn.initiatedAt.getTime();

        if (timeSinceInitiation > 30000) {
          // 30 seconds passed, query M-Pesa API
          console.log(`⏰ 30s elapsed, querying M-Pesa API directly...`);

          try {
            const queryResult = await mpesaService.stkQuery(checkoutRequestId);
            console.log(
              `📊 M-Pesa Query Result:`,
              JSON.stringify(queryResult, null, 2)
            );

            // Check if payment was successful
            if (queryResult.ResultCode === "0") {
              // Payment successful - save to DB
              const transaction = await prisma.mpesaTransaction.create({
                data: {
                  userId: pendingTxn.userId,
                  userName: pendingTxn.userName,
                  phoneNumber: pendingTxn.phoneNumber,
                  amount: pendingTxn.amount,
                  accountReference: pendingTxn.accountReference,
                  merchantRequestId: pendingTxn.merchantRequestId,
                  checkoutRequestId: checkoutRequestId,
                  mpesaReceiptNumber: null, // Query doesn't return receipt
                  transactionDate: null,
                  resultCode: parseInt(queryResult.ResultCode),
                  resultDesc: queryResult.ResultDesc || "Success",
                  status: "SUCCESS",
                },
              });

              pendingTransactions.delete(checkoutRequestId);
              console.log(`✅ Payment confirmed via query - saved to DB`);

              return res.status(200).json({
                success: true,
                status: "SUCCESS",
                data: transaction,
              });
            } else if (queryResult.ResultCode === "1032") {
              // User cancelled
              pendingTransactions.delete(checkoutRequestId);
              console.log(`❌ Payment cancelled by user`);

              return res.status(200).json({
                success: false,
                status: "CANCELLED",
                message: "Payment was cancelled",
              });
            }
          } catch (queryError: any) {
            console.error(`❌ M-Pesa query failed:`, queryError.message);
          }
        }

        // Still waiting for user to complete payment
        console.log(`⏳ Still pending - waiting for callback`);
        return res.status(200).json({
          success: true,
          status: "PENDING",
          message: "Waiting for payment confirmation",
          data: {
            userId: pendingTxn.userId,
            amount: pendingTxn.amount,
            phoneNumber: pendingTxn.phoneNumber,
            accountReference: pendingTxn.accountReference,
            initiatedAt: pendingTxn.initiatedAt,
          },
        });
      }

      // Not found in either - either expired, cancelled, or failed
      console.log(`❌ Not found - likely expired or failed`);
      return res.status(404).json({
        success: false,
        status: "NOT_FOUND",
        message:
          "Transaction not found. It may have expired, been cancelled, or failed.",
      });
    } catch (error: any) {
      console.error("❌ Status Check Error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to check transaction status",
      });
    }
  }
);

/**
 * GET /api/mpesa/transactions/:userId
 * Get user's transaction history
 */
router.get("/transactions/:userId", async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { limit = "20", offset = "0" } = req.query;

    const transactions = await prisma.mpesaTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: parseInt(limit as string),
      skip: parseInt(offset as string),
    });

    return res.status(200).json({
      success: true,
      data: transactions,
    });
  } catch (error: any) {
    console.error("❌ Transaction History Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch transactions",
    });
  }
});

export default router;
