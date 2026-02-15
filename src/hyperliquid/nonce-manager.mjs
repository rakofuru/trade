export class NonceManager {
  constructor() {
    this.lastNonce = 0;
  }

  next() {
    const now = Date.now();
    if (now <= this.lastNonce) {
      this.lastNonce += 1;
    } else {
      this.lastNonce = now;
    }
    return this.lastNonce;
  }
}