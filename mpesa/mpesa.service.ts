import axios from "axios";

interface MpesaConfig {
  consumerKey: string;
  consumerSecret: string;
  passkey: string;
  shortCode: string;
  callbackUrl: string;
  environment: "sandbox" | "production";
}

export class MpesaService {
  private config: MpesaConfig;
  private baseUrl: string;

  constructor(config: MpesaConfig) {
    this.config = config;
    this.baseUrl =
      config.environment === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke";
  }

  /**
   * Generate OAuth access token
   */
  private async getAccessToken(): Promise<string> {
    const auth = Buffer.from(
      `${this.config.consumerKey}:${this.config.consumerSecret}`
    ).toString("base64");

    try {
      const response = await axios.get(
        `${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
        {
          headers: {
            Authorization: `Basic ${auth}`,
          },
        }
      );

      return response.data.access_token;
    } catch (error: any) {
      console.error(
        "❌ M-Pesa Token Error:",
        error.response?.data || error.message
      );
      throw new Error("Failed to get M-Pesa access token");
    }
  }

  /**
   * Generate password for STK Push
   */
  private generatePassword(): { password: string; timestamp: string } {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14);
    const password = Buffer.from(
      `${this.config.shortCode}${this.config.passkey}${timestamp}`
    ).toString("base64");

    return { password, timestamp };
  }

  /**
   * Initiate STK Push (Lipa na M-Pesa Online)
   */
  async stkPush(
    phoneNumber: string,
    amount: number,
    accountReference: string,
    transactionDesc: string = "Payment"
  ): Promise<any> {
    const accessToken = await this.getAccessToken();
    const { password, timestamp } = this.generatePassword();

    // Format phone number (remove + if present, ensure 254 prefix)
    let formattedPhone = phoneNumber.replace(/\+/g, "");
    if (formattedPhone.startsWith("0")) {
      formattedPhone = "254" + formattedPhone.substring(1);
    } else if (!formattedPhone.startsWith("254")) {
      formattedPhone = "254" + formattedPhone;
    }

    const payload = {
      BusinessShortCode: this.config.shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(amount), // M-Pesa doesn't accept decimals
      PartyA: formattedPhone,
      PartyB: this.config.shortCode,
      PhoneNumber: formattedPhone,
      CallBackURL: this.config.callbackUrl,
      AccountReference: accountReference,
      TransactionDesc: transactionDesc,
    };

    try {
      const response = await axios.post(
        `${this.baseUrl}/mpesa/stkpush/v1/processrequest`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      return response.data;
    } catch (error: any) {
      console.error(
        "❌ M-Pesa STK Push Error:",
        error.response?.data || error.message
      );
      throw new Error(error.response?.data?.errorMessage || "STK Push failed");
    }
  }

  /**
   * Query STK Push transaction status
   */
  async stkQuery(checkoutRequestId: string): Promise<any> {
    const accessToken = await this.getAccessToken();
    const { password, timestamp } = this.generatePassword();

    const payload = {
      BusinessShortCode: this.config.shortCode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    };

    try {
      const response = await axios.post(
        `${this.baseUrl}/mpesa/stkpushquery/v1/query`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      return response.data;
    } catch (error: any) {
      console.error(
        "❌ M-Pesa Query Error:",
        error.response?.data || error.message
      );
      throw new Error("STK Query failed");
    }
  }
}

// Initialize M-Pesa service with environment variables
export const mpesaService = new MpesaService({
  consumerKey: process.env.MPESA_CONSUMER_KEY || "",
  consumerSecret: process.env.MPESA_CONSUMER_SECRET || "",
  passkey: process.env.MPESA_PASSKEY || "",
  shortCode: process.env.MPESA_SHORT_CODE || "",
  callbackUrl: process.env.MPESA_CALLBACK_URL || "",
  environment:
    (process.env.MPESA_ENVIRONMENT as "sandbox" | "production") || "sandbox",
});
