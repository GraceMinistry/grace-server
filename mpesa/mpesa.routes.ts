import { Router, Request, Response } from "express";
import { prisma } from "../prisma";
import { mpesaService } from "./mpesa.service";

const router = Router();

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

    // Store transaction in database
    const transaction = await prisma.mpesaTransaction.create({
      data: {
        userId,
        userName: userName || null,
        phoneNumber,
        amount,
        accountReference,
        merchantRequestId: stkResponse.MerchantRequestID,
        checkoutRequestId: stkResponse.CheckoutRequestID,
        status: "PENDING",
      },
    });

    return res.status(200).json({
      success: true,
      message: "STK Push sent successfully. Please check your phone.",
      data: {
        transactionId: transaction.id,
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
    console.log(
      "📲 M-Pesa Callback Received:",
      JSON.stringify(req.body, null, 2)
    );

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

    // Find transaction
    const transaction = await prisma.mpesaTransaction.findUnique({
      where: { checkoutRequestId: CheckoutRequestID },
    });

    if (!transaction) {
      console.warn("⚠️ Transaction not found:", CheckoutRequestID);
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
    }

    // Update transaction based on result
    if (ResultCode === 0) {
      // Success
      const metadata = CallbackMetadata?.Item || [];
      const mpesaReceiptNumber = metadata.find(
        (item: any) => item.Name === "MpesaReceiptNumber"
      )?.Value;
      const transactionDate = metadata.find(
        (item: any) => item.Name === "TransactionDate"
      )?.Value;
      const mpesaUserName = metadata.find(
        (item: any) => item.Name === "FirstName" || item.Name === "LastName"
      )?.Value;

      await prisma.mpesaTransaction.update({
        where: { id: transaction.id },
        data: {
          status: "SUCCESS",
          resultCode: ResultCode,
          userName: transaction.userName || mpesaUserName || null,
          resultDesc: ResultDesc,
          mpesaReceiptNumber,
          transactionDate: transactionDate
            ? new Date(String(transactionDate))
            : null,
        },
      });

      console.log("✅ Payment Successful:", mpesaReceiptNumber);
    } else {
      // Failed or Cancelled
      await prisma.mpesaTransaction.update({
        where: { id: transaction.id },
        data: {
          status: ResultCode === 1032 ? "CANCELLED" : "FAILED",
          resultCode: ResultCode,
          resultDesc: ResultDesc,
        },
      });

      console.log("❌ Payment Failed:", ResultDesc);
    }

    return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (error: any) {
    console.error("❌ M-Pesa Callback Error:", error);
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  }
});

/**
 * GET /api/mpesa/status/:transactionId
 * Check transaction status
 */
router.get("/status/:transactionId", async (req: Request, res: Response) => {
  try {
    const { transactionId } = req.params;

    const transaction = await prisma.mpesaTransaction.findUnique({
      where: { id: transactionId },
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction not found",
      });
    }

    // If still pending and has checkoutRequestId, query M-Pesa
    if (transaction.status === "PENDING" && transaction.checkoutRequestId) {
      try {
        const queryResponse = await mpesaService.stkQuery(
          transaction.checkoutRequestId
        );

        // Update status based on query response
        if (queryResponse.ResultCode === "0") {
          await prisma.mpesaTransaction.update({
            where: { id: transactionId },
            data: {
              status: "SUCCESS",
              resultCode: 0,
              resultDesc: queryResponse.ResultDesc,
            },
          });
          transaction.status = "SUCCESS";
        }
      } catch (queryError) {
        console.error("Query error:", queryError);
      }
    }

    return res.status(200).json({
      success: true,
      data: transaction,
    });
  } catch (error: any) {
    console.error("❌ Status Check Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to check transaction status",
    });
  }
});

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
