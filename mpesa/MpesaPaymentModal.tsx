import React, { useState } from "react";

interface MpesaPaymentModalProps {
  userId: string;
  userName?: string; // Optional: Pass from Clerk/auth provider
  onSuccess?: (transactionId: string) => void;
  onError?: (error: string) => void;
  onClose?: () => void;
}

export const MpesaPaymentModal: React.FC<MpesaPaymentModalProps> = ({
  userId,
  userName,
  onSuccess,
  onError,
  onClose,
}) => {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [account, setAccount] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [checkoutRequestId, setCheckoutRequestId] = useState<string | null>(
    null
  );

  const accountOptions = [
    { value: "ROOM_PAYMENT", label: "Room Payment" },
    { value: "SUBSCRIPTION", label: "Subscription" },
    { value: "CREDITS", label: "Buy Credits" },
    { value: "DONATION", label: "Donation" },
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const apiUrl =
        process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:8080";
      const response = await fetch(`${apiUrl}/api/mpesa/initiate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId,
          userName, // Include userName from props
          phoneNumber,
          amount: parseFloat(amount),
          accountReference: account,
        }),
      });

      const data = await response.json();

      if (data.success) {
        setCheckoutRequestId(data.data.checkoutRequestId);
        alert(
          "Payment request sent! Please check your phone and enter your M-Pesa PIN."
        );

        // Start checking payment status
        setTimeout(() => checkPaymentStatus(data.data.checkoutRequestId), 5000);
      } else {
        onError?.(data.message || "Payment initiation failed");
        alert(data.message || "Payment initiation failed");
      }
    } catch (error: any) {
      onError?.(error.message);
      alert("Error initiating payment: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  const checkPaymentStatus = async (checkoutReqId: string) => {
    setCheckingStatus(true);
    let attempts = 0;
    const maxAttempts = 12; // Check for 1 minute (12 * 5 seconds)

    const checkStatus = async () => {
      try {
        const apiUrl =
          process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:8080";
        const response = await fetch(
          `${apiUrl}/api/mpesa/status/${checkoutReqId}`
        );
        const data = await response.json();

        if (data.status === "SUCCESS") {
          onSuccess?.(data.data.id);
          alert(`Payment successful! Receipt: ${data.data.mpesaReceiptNumber}`);
          setCheckingStatus(false);
          onClose?.();
          return;
        }

        if (data.status === "NOT_FOUND") {
          onError?.(data.message || "Payment not completed");
          alert(data.message || "Payment failed or was cancelled");
          setCheckingStatus(false);
          return;
        }

        if (data.status === "PENDING") {
          // Still waiting - check again
          attempts++;
          if (attempts < maxAttempts) {
            setTimeout(checkStatus, 5000);
          } else {
            setCheckingStatus(false);
            alert(
              "Payment verification timeout. Please check transaction history."
            );
          }
          return;
        }
      } catch (error) {
        console.error("Error checking status:", error);
        setCheckingStatus(false);
      }
    };

    checkStatus();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold text-gray-800">Pay with M-Pesa</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
            disabled={loading || checkingStatus}
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Phone Number */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Phone Number
            </label>
            <input
              type="tel"
              placeholder="0712345678 or 254712345678"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-green-500"
              required
              disabled={loading || checkingStatus}
            />
            <p className="text-xs text-gray-500 mt-1">
              Enter Safaricom number registered with M-Pesa
            </p>
          </div>

          {/* Amount */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Amount (KES)
            </label>
            <input
              type="number"
              placeholder="100"
              min="1"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-green-500"
              required
              disabled={loading || checkingStatus}
            />
          </div>

          {/* Account Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Payment For
            </label>
            <select
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-green-500"
              required
              disabled={loading || checkingStatus}
            >
              <option value="">Select account...</option>
              {accountOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={loading || checkingStatus}
            className="w-full bg-green-600 text-white py-3 rounded-md font-semibold hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            {loading
              ? "Sending Request..."
              : checkingStatus
              ? "Verifying Payment..."
              : "Pay Now"}
          </button>
        </form>

        {checkingStatus && (
          <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
            <p className="text-sm text-yellow-800">
              ⏳ Waiting for payment confirmation... Please complete the payment
              on your phone.
            </p>
          </div>
        )}

        <div className="mt-4 p-3 bg-gray-50 rounded-md">
          <p className="text-xs text-gray-600">
            💡 You will receive an STK Push prompt on your phone. Enter your
            M-Pesa PIN to complete the payment.
          </p>
        </div>
      </div>
    </div>
  );
};

// Example usage in a component:
/*
import { MpesaPaymentModal } from './MpesaPaymentModal';
import { useUser } from '@clerk/clerk-react'; // or your auth provider

function MyComponent() {
  const [showPayment, setShowPayment] = useState(false);
  const { user } = useUser(); // Get user from Clerk
  const userId = user?.id || "your-clerk-user-id";
  const userName = user?.fullName || user?.firstName || undefined;

  return (
    <>
      <button onClick={() => setShowPayment(true)}>
        Pay with M-Pesa
      </button>

      {showPayment && (
        <MpesaPaymentModal
          userId={userId}
          userName={userName} // Pass user's name from Clerk
          onSuccess={(transactionId) => {
            console.log("Payment successful:", transactionId);
            setShowPayment(false);
          }}
          onError={(error) => {
            console.error("Payment error:", error);
          }}
          onClose={() => setShowPayment(false)}
        />
      )}
    </>
  );
}
*/
