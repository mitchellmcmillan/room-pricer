const isProd = import.meta.env.PROD;

export const API_BASE = isProd
  ? 'https://nas.mitchellmcmillan.com:44355'
  : 'http://localhost:8080';

export const WS_BASE = isProd
  ? 'wss://nas.mitchellmcmillan.com:44355'
  : 'ws://localhost:8080';

export function getWebSocketUrl(auctionId) {
  const params = new URLSearchParams();
  if (auctionId) params.set('auctionId', auctionId);
  const qs = params.toString();
  return qs ? `${WS_BASE}/?${qs}` : WS_BASE;
}
