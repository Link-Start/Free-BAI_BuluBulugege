-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "address" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "sessionCookie" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "credits" INTEGER NOT NULL DEFAULT 100000,
    "proxy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "last_check_at" DATETIME,
    "last_used_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "usage_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "request_id" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "usage_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_address_key" ON "accounts"("address");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_api_key_key" ON "accounts"("api_key");

-- CreateIndex
CREATE INDEX "accounts_status_credits_idx" ON "accounts"("status", "credits");

-- CreateIndex
CREATE INDEX "usage_logs_account_id_idx" ON "usage_logs"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");
