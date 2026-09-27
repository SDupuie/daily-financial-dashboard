// displayName is published provenance metadata; keep it stable with the source
// catalog so Apply never has to infer reader-facing labels from domains.
const APPROVED_ARTICLE_ACCESS = new Set(['open', 'mixed', 'subscription']);

const APPROVED_NEWS_SOURCES = Object.freeze([
  { id: 'ap', displayName: 'AP', domains: ['apnews.com'], articleAccess: 'open' },
  { id: 'reuters', displayName: 'Reuters', domains: ['reuters.com'], articleAccess: 'mixed' },
  { id: 'marketscreener', displayName: 'MarketScreener', domains: ['marketscreener.com'], articleAccess: 'mixed' },
  { id: 'cnbc', displayName: 'CNBC', domains: ['cnbc.com'], articleAccess: 'mixed' },
  { id: 'cnbc-tv18', displayName: 'CNBC TV18', domains: ['cnbctv18.com'], articleAccess: 'mixed' },
  { id: 'investopedia', displayName: 'Investopedia', domains: ['investopedia.com'], articleAccess: 'open' },
  { id: 'kiplinger', displayName: 'Kiplinger', domains: ['kiplinger.com'], articleAccess: 'open' },
  { id: 'yahoo-finance', displayName: 'Yahoo Finance', domains: ['finance.yahoo.com'], articleAccess: 'mixed' },
  { id: 'morningstar', displayName: 'Morningstar', domains: ['morningstar.com'], articleAccess: 'mixed' },
  { id: 'the-street', displayName: 'TheStreet', domains: ['thestreet.com'], articleAccess: 'mixed' },
  { id: 'us-news-money', displayName: 'U.S. News Money', domains: ['money.usnews.com'], articleAccess: 'open' },
  { id: 'axios', displayName: 'Axios', domains: ['axios.com'], articleAccess: 'mixed' },
  { id: 'business-insider', displayName: 'Business Insider', domains: ['businessinsider.com'], articleAccess: 'mixed' },
  { id: 'fox-business', displayName: 'Fox Business', domains: ['foxbusiness.com'], articleAccess: 'open' },
  { id: 'abc-news', displayName: 'ABC News', domains: ['abcnews.go.com'], articleAccess: 'open' },
  { id: 'guardian', displayName: 'The Guardian', domains: ['theguardian.com'], articleAccess: 'open' },
  { id: 'investing-com', displayName: 'Investing.com', domains: ['investing.com'], articleAccess: 'mixed' },
  { id: 'mining-com', displayName: 'Mining.com', domains: ['mining.com'], articleAccess: 'open' },
  { id: 'coindesk', displayName: 'CoinDesk', domains: ['coindesk.com'], articleAccess: 'open' },
  { id: 'crypto-briefing', displayName: 'Crypto Briefing', domains: ['cryptobriefing.com'], articleAccess: 'open' },
  { id: 'decrypt', displayName: 'Decrypt', domains: ['decrypt.co'], articleAccess: 'open' },
  { id: 'the-block', displayName: 'The Block', domains: ['theblock.co'], articleAccess: 'mixed' },
  { id: 'crypto-news', displayName: 'Crypto.news', domains: ['crypto.news'], articleAccess: 'open' },
  { id: 'crypto-slate', displayName: 'CryptoSlate', domains: ['cryptoslate.com'], articleAccess: 'mixed' },
  { id: 'fx-news-group', displayName: 'FX News Group', domains: ['fxnewsgroup.com'], articleAccess: 'open' },
  { id: 'coingecko', displayName: 'CoinGecko', domains: ['coingecko.com'], articleAccess: 'open' },
  { id: 'coinmarketcap', displayName: 'CoinMarketCap', domains: ['coinmarketcap.com'], articleAccess: 'open' },
  { id: 'alternative-me', displayName: 'Alternative.me', domains: ['alternative.me'], articleAccess: 'open' },
  { id: 'federal-reserve', displayName: 'Federal Reserve', domains: ['federalreserve.gov'], articleAccess: 'open' },
  { id: 'treasury', displayName: 'U.S. Treasury', domains: ['treasury.gov'], articleAccess: 'open' },
  { id: 'bls', displayName: 'BLS', domains: ['bls.gov'], articleAccess: 'open' },
  { id: 'bea', displayName: 'BEA', domains: ['bea.gov'], articleAccess: 'open' },
  { id: 'sec', displayName: 'SEC', domains: ['sec.gov'], articleAccess: 'open' },
  { id: 'cftc', displayName: 'CFTC', domains: ['cftc.gov'], articleAccess: 'open' },
  { id: 'cme', displayName: 'CME Group', domains: ['cmegroup.com'], articleAccess: 'open' },
  { id: 'nyse', displayName: 'NYSE', domains: ['nyse.com'], articleAccess: 'open' },
  { id: 'nasdaq', displayName: 'Nasdaq', domains: ['nasdaq.com'], articleAccess: 'open' },
  { id: 'sp-global', displayName: 'S&P Global', domains: ['spglobal.com'], articleAccess: 'mixed' },
  { id: 'coinbase', displayName: 'Coinbase', domains: ['coinbase.com'], articleAccess: 'open' },
  { id: 'kraken', displayName: 'Kraken', domains: ['kraken.com'], articleAccess: 'open' },
  { id: 'blackrock', displayName: 'BlackRock', domains: ['blackrock.com'], articleAccess: 'open' },
  { id: 'fidelity', displayName: 'Fidelity', domains: ['fidelity.com'], articleAccess: 'open' },
  { id: 'grayscale', displayName: 'Grayscale', domains: ['grayscale.com'], articleAccess: 'open' }
].map((source) => {
  if (!APPROVED_ARTICLE_ACCESS.has(source.articleAccess)) {
    throw new Error(`Invalid article access classification for News source ${source.id}.`);
  }
  return Object.freeze({ ...source, domains: Object.freeze(source.domains) });
}));

const ALPHA_VANTAGE_NEWS_PATHS = Object.freeze([
  { id: 'alpha-blockchain', provider: 'alpha-vantage', pool: 'cryptoCandidates', topic: 'blockchain' }
].map((entry) => Object.freeze(entry)));

const STOCKFIT_NEWS_PATHS = Object.freeze([
  { id: 'stockfit-market', provider: 'stockfit', pool: 'generalCandidates', limit: 50 }
].map((entry) => Object.freeze(entry)));

const MARKETAUX_TICKER_NEWS_PATHS = Object.freeze([
  { id: 'marketaux-ibit', provider: 'marketaux', pool: 'cryptoCandidates', ticker: 'IBIT', limit: 3 },
  { id: 'marketaux-etha', provider: 'marketaux', pool: 'cryptoCandidates', ticker: 'ETHA', limit: 3 },
  { id: 'marketaux-mstr', provider: 'marketaux', pool: 'cryptoCandidates', ticker: 'MSTR', limit: 3 }
].map((entry) => Object.freeze(entry)));

const DIRECT_NEWS_FEEDS = Object.freeze([
  { id: 'ap-public', provider: 'ap-public', pool: 'generalCandidates', feedUrl: 'https://apnews.com/news-sitemap-content.xml' },
  { id: 'marketscreener-reuters', provider: 'marketscreener-reuters', pool: 'generalCandidates', feedUrl: 'https://www.marketscreener.com/news/' },
  { id: 'investing-market', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_25.rss' },
  { id: 'investing-economy', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_14.rss' },
  { id: 'investing-indicators', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_95.rss' },
  { id: 'investing-earnings', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_1062.rss' },
  { id: 'investing-commodities', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_11.rss' },
  { id: 'investing-crypto', provider: 'rss', pool: 'cryptoCandidates', feedUrl: 'https://www.investing.com/rss/news_301.rss' },
  { id: 'axios', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://api.axios.com/feed/' },
  { id: 'coindesk', provider: 'rss', pool: 'cryptoCandidates', feedUrl: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { id: 'decrypt', provider: 'rss', pool: 'cryptoCandidates', feedUrl: 'https://decrypt.co/feed' },
  { id: 'crypto-news', provider: 'rss', pool: 'cryptoCandidates', feedUrl: 'https://crypto.news/feed/' },
  { id: 'crypto-slate', provider: 'rss', pool: 'cryptoCandidates', feedUrl: 'https://cryptoslate.com/feed/' },
  { id: 'cnbc', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' }
].map((entry) => Object.freeze(entry)));

function newsAcquisitionPaths() {
  return Object.freeze([
    ...ALPHA_VANTAGE_NEWS_PATHS,
    ...STOCKFIT_NEWS_PATHS,
    ...MARKETAUX_TICKER_NEWS_PATHS,
    ...DIRECT_NEWS_FEEDS
  ]);
}

module.exports = {
  APPROVED_NEWS_SOURCES,
  ALPHA_VANTAGE_NEWS_PATHS,
  DIRECT_NEWS_FEEDS,
  MARKETAUX_TICKER_NEWS_PATHS,
  STOCKFIT_NEWS_PATHS,
  newsAcquisitionPaths
};
