/**
 * Base L2 funder — 给新注册钱包打 dust 让 claim 的余额检查通过
 *
 * 特性：
 * - 单例 funder 钱包（从 FUNDER_PRIVATE_KEY 加载）
 * - 本地维护 nonce，避免并发时抢 nonce 失败
 * - 发送完 tx 后等待 1 个 confirmation（保证 BankOfAI indexer 能看到）
 */
import { ethers } from "ethers";
import { BASE_CHAIN } from "@/lib/constants";

class BaseFunder {
  private provider: ethers.JsonRpcProvider | null = null;
  private funder: ethers.Wallet | null = null;
  private nonce: number | null = null;
  private nonceLock: Promise<void> = Promise.resolve();
  private dustWei: bigint | null = null;

  private async ensureReady() {
    if (!BASE_CHAIN.enabled) {
      throw new Error("FUNDER_PRIVATE_KEY not configured");
    }
    if (!this.provider) this.provider = new ethers.JsonRpcProvider(BASE_CHAIN.rpc);
    if (!this.funder) this.funder = new ethers.Wallet(BASE_CHAIN.funderPrivateKey, this.provider);
    if (this.dustWei === null) this.dustWei = ethers.parseEther(BASE_CHAIN.dustEth);
    if (this.nonce === null) {
      this.nonce = await this.provider.getTransactionCount(this.funder.address, "pending");
    }
  }

  /**
   * 分配下一个 nonce（串行化）
   */
  private async nextNonce(): Promise<number> {
    await this.ensureReady();
    // 等上一个分配完再给下一个
    const prev = this.nonceLock;
    let release!: () => void;
    this.nonceLock = new Promise((r) => { release = r; });
    await prev;
    const n = this.nonce!;
    this.nonce = n + 1;
    release();
    return n;
  }

  /**
   * 给目标地址打 dust 并等 1 确认
   */
  async fund(toAddress: string): Promise<{ hash: string; blockNumber: number }> {
    await this.ensureReady();
    const nonce = await this.nextNonce();
    try {
      const tx = await this.funder!.sendTransaction({
        to: toAddress,
        value: this.dustWei!,
        nonce,
      });
      const receipt = await tx.wait(1);
      if (!receipt) throw new Error("fund receipt missing");
      return { hash: tx.hash, blockNumber: receipt.blockNumber };
    } catch (e) {
      // nonce 消耗了但 tx 发送失败时，回退本地 nonce（避免卡死）
      // 注意：如果 tx 已经广播只是 wait 超时，回退 nonce 会造成下一笔 nonce 冲突，
      // 所以只在"发送前就报错"时回退 —— 但 ethers 没有明确 flag，保守做法：只记录不回退
      throw e;
    }
  }

  /**
   * 查 funder 当前余额（运维用）
   */
  async getBalance(): Promise<bigint> {
    await this.ensureReady();
    return this.provider!.getBalance(this.funder!.address);
  }

  getAddress(): string {
    if (!BASE_CHAIN.enabled) return "";
    // 不初始化 provider 也能算出地址
    if (!this.funder) this.funder = new ethers.Wallet(BASE_CHAIN.funderPrivateKey);
    return this.funder.address;
  }
}

export const baseFunder = new BaseFunder();
