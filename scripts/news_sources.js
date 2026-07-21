// displayName is published provenance metadata; keep it stable with the source
// catalog so Apply never has to infer reader-facing labels from domains.
const APPROVED_NEWS_SOURCES = Object.freeze([
  { id: 'ap', displayName: 'AP', domains: ['apnews.com'] },
  { id: 'reuters', displayName: 'Reuters', domains: ['reuters.com'] },
  { id: 'cnbc', displayName: 'CNBC', domains: ['cnbc.com'] },
  { id: 'cnbc-tv18', displayName: 'CNBC TV18', domains: ['cnbctv18.com'] },
  { id: 'investopedia', displayName: 'Investopedia', domains: ['investopedia.com'] },
  { id: 'kiplinger', displayName: 'Kiplinger', domains: ['kiplinger.com'] },
  { id: 'yahoo-finance', displayName: 'Yahoo Finance', domains: ['finance.yahoo.com'] },
  { id: 'morningstar', displayName: 'Morningstar', domains: ['morningstar.com'] },
  { id: 'the-street', displayName: 'TheStreet', domains: ['thestreet.com'] },
  { id: 'us-news-money', displayName: 'U.S. News Money', domains: ['money.usnews.com'] },
  { id: 'axios', displayName: 'Axios', domains: ['axios.com'] },
  { id: 'business-insider', displayName: 'Business Insider', domains: ['businessinsider.com'] },
  { id: 'fox-business', displayName: 'Fox Business', domains: ['foxbusiness.com'] },
  { id: 'abc-news', displayName: 'ABC News', domains: ['abcnews.go.com'] },
  { id: 'guardian', displayName: 'The Guardian', domains: ['theguardian.com'] },
  { id: 'investing-com', displayName: 'Investing.com', domains: ['investing.com'] },
  { id: 'mining-com', displayName: 'Mining.com', domains: ['mining.com'] },
  { id: 'coindesk', displayName: 'CoinDesk', domains: ['coindesk.com'] },
  { id: 'crypto-briefing', displayName: 'Crypto Briefing', domains: ['cryptobriefing.com'] },
  { id: 'decrypt', displayName: 'Decrypt', domains: ['decrypt.co'] },
  { id: 'blockworks', displayName: 'Blockworks', domains: ['blockworks.co'] },
  { id: 'the-block', displayName: 'The Block', domains: ['theblock.co'] },
  { id: 'dl-news', displayName: 'DL News', domains: ['dlnews.com'] },
  { id: 'crypto-news', displayName: 'Crypto.news', domains: ['crypto.news'] },
  { id: 'fx-news-group', displayName: 'FX News Group', domains: ['fxnewsgroup.com'] },
  { id: 'coingecko', displayName: 'CoinGecko', domains: ['coingecko.com'] },
  { id: 'coinmarketcap', displayName: 'CoinMarketCap', domains: ['coinmarketcap.com'] },
  { id: 'alternative-me', displayName: 'Alternative.me', domains: ['alternative.me'] },
  { id: 'federal-reserve', displayName: 'Federal Reserve', domains: ['federalreserve.gov'] },
  { id: 'treasury', displayName: 'U.S. Treasury', domains: ['treasury.gov'] },
  { id: 'bls', displayName: 'BLS', domains: ['bls.gov'] },
  { id: 'bea', displayName: 'BEA', domains: ['bea.gov'] },
  { id: 'sec', displayName: 'SEC', domains: ['sec.gov'] },
  { id: 'cftc', displayName: 'CFTC', domains: ['cftc.gov'] },
  { id: 'cme', displayName: 'CME Group', domains: ['cmegroup.com'] },
  { id: 'nyse', displayName: 'NYSE', domains: ['nyse.com'] },
  { id: 'nasdaq', displayName: 'Nasdaq', domains: ['nasdaq.com'] },
  { id: 'sp-global', displayName: 'S&P Global', domains: ['spglobal.com'] },
  { id: 'coinbase', displayName: 'Coinbase', domains: ['coinbase.com'] },
  { id: 'kraken', displayName: 'Kraken', domains: ['kraken.com'] },
  { id: 'blackrock', displayName: 'BlackRock', domains: ['blackrock.com'] },
  { id: 'fidelity', displayName: 'Fidelity', domains: ['fidelity.com'] },
  { id: 'grayscale', displayName: 'Grayscale', domains: ['grayscale.com'] }
].map((source) => Object.freeze({ ...source, domains: Object.freeze(source.domains) })));

const ALPHA_VANTAGE_NEWS_PATHS = Object.freeze([
  { id: 'alpha-financial-markets', provider: 'alpha-vantage', pool: 'generalCandidates', topic: 'financial_markets' },
  { id: 'alpha-blockchain', provider: 'alpha-vantage', pool: 'cryptoCandidates', topic: 'blockchain' }
].map((entry) => Object.freeze(entry)));

const STOCKFIT_NEWS_PATHS = Object.freeze([
  { id: 'stockfit-market', provider: 'stockfit', pool: 'generalCandidates', limit: 50 }
].map((entry) => Object.freeze(entry)));

const DIRECT_NEWS_FEEDS = Object.freeze([
  { id: 'ap-public', provider: 'ap-public', pool: 'generalCandidates', feedUrl: 'https://apnews.com/news-sitemap-content.xml' },
  { id: 'investing-market', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_25.rss' },
  { id: 'investing-economy', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_14.rss' },
  { id: 'investing-indicators', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_95.rss' },
  { id: 'investing-earnings', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_1062.rss' },
  { id: 'investing-company', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_356.rss' },
  { id: 'investing-commodities', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_11.rss' },
  { id: 'investing-crypto', provider: 'rss', pool: 'cryptoCandidates', feedUrl: 'https://www.investing.com/rss/news_301.rss' },
  { id: 'axios', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://api.axios.com/feed/' },
  { id: 'kiplinger', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.kiplinger.com/feed/all' },
  { id: 'coindesk', provider: 'rss', pool: 'cryptoCandidates', feedUrl: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { id: 'decrypt', provider: 'rss', pool: 'cryptoCandidates', feedUrl: 'https://decrypt.co/feed' },
  { id: 'cnbc', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' }
].map((entry) => Object.freeze(entry)));

function newsAcquisitionPaths() {
  return Object.freeze([
    ...ALPHA_VANTAGE_NEWS_PATHS,
    ...STOCKFIT_NEWS_PATHS,
    ...DIRECT_NEWS_FEEDS
  ]);
}

module.exports = {
  APPROVED_NEWS_SOURCES,
  ALPHA_VANTAGE_NEWS_PATHS,
  DIRECT_NEWS_FEEDS,
  STOCKFIT_NEWS_PATHS,
  newsAcquisitionPaths
};
