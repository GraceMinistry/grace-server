-- CreateTable
CREATE TABLE "MpesaTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "accountReference" TEXT NOT NULL,
    "merchantRequestId" TEXT,
    "checkoutRequestId" TEXT,
    "mpesaReceiptNumber" TEXT,
    "transactionDate" TIMESTAMP(3),
    "resultCode" INTEGER,
    "resultDesc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MpesaTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MpesaTransaction_merchantRequestId_key" ON "MpesaTransaction"("merchantRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "MpesaTransaction_checkoutRequestId_key" ON "MpesaTransaction"("checkoutRequestId");

-- CreateIndex
CREATE INDEX "MpesaTransaction_userId_idx" ON "MpesaTransaction"("userId");

-- CreateIndex
CREATE INDEX "MpesaTransaction_phoneNumber_idx" ON "MpesaTransaction"("phoneNumber");

-- CreateIndex
CREATE INDEX "MpesaTransaction_status_idx" ON "MpesaTransaction"("status");
