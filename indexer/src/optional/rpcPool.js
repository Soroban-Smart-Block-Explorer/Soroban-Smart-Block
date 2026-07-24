const axios = require('axios');

class RpcPool {
  constructor(urls, logger) {
    this.urls = urls;
    this.logger = logger;
    this.weights = urls.reduce((acc, url) => ({ ...acc, [url]: 1 }), {});
    this.requestCounts = urls.reduce((acc, url) => ({ ...acc, [url]: 0 }), {});
    this.successCounts = urls.reduce((acc, url) => ({ ...acc, [url]: 0 }), {});
    this.healthyUrls = new Set(urls);
    this.startHealthCheck();
  }

  startHealthCheck() {
    setInterval(async () => {
      for (const url of this.urls) {
        try {
          await axios.post(`${url}/`, {
            jsonrpc: '2.0',
            id: 1,
            method: 'getLatestLedger',
            params: [],
          }, { timeout: 5000 });
          this.healthyUrls.add(url);
        } catch (err) {
          this.healthyUrls.delete(url);
          this.logger.warn({ url, error: err.message }, 'RPC health check failed');
        }
      }
    }, 30000);
  }

  async request(method, params) {
    const urls = this.urls.filter(url => this.healthyUrls.has(url));
    if (urls.length === 0) urls.push(...this.urls);

    for (const url of urls) {
      try {
        this.requestCounts[url]++;
        const response = await axios.post(url, {
          jsonrpc: '2.0',
          id: 1,
          method,
          params,
        });
        this.successCounts[url]++;
        this.updateWeights();
        return response.data;
      } catch (err) {
        this.logger.warn({ url, error: err.message }, 'RPC request failed, trying next URL');
        continue;
      }
    }
    throw new Error('All RPC endpoints failed');
  }

  updateWeights() {
    for (const url of this.urls) {
      const total = this.requestCounts[url] || 1;
      const success = this.successCounts[url] || 0;
      this.weights[url] = success / total;
    }
  }

  getHealthStatus() {
    return this.urls.map(url => ({
      url,
      status: this.healthyUrls.has(url) ? 1 : 0,
      weight: this.weights[url],
    }));
  }
}

module.exports = RpcPool;
