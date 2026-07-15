const APPROVED_NEWS_SOURCES = Object.freeze([
  { id: 'ap', domains: ['apnews.com'] },
  { id: 'reuters', domains: ['reuters.com'] },
  { id: 'cnbc', domains: ['cnbc.com'] },
  { id: 'cnbc-tv18', domains: ['cnbctv18.com'] },
  { id: 'investopedia', domains: ['investopedia.com'] },
  { id: 'kiplinger', domains: ['kiplinger.com'] },
  { id: 'ibd', domains: ['investors.com'] },
  { id: 'yahoo-finance', domains: ['finance.yahoo.com'] },
  { id: 'morningstar', domains: ['morningstar.com'] },
  { id: 'the-street', domains: ['thestreet.com'] },
  { id: 'us-news-money', domains: ['money.usnews.com'] },
  { id: 'marketwatch', domains: ['marketwatch.com'] },
  { id: 'axios', domains: ['axios.com'] },
  { id: 'fortune', domains: ['fortune.com'] },
  { id: 'business-insider', domains: ['businessinsider.com'] },
  { id: 'fox-business', domains: ['foxbusiness.com'] },
  { id: 'abc-news', domains: ['abcnews.go.com'] },
  { id: 'guardian', domains: ['theguardian.com'] },
  { id: 'financial-times', domains: ['ft.com'] },
  { id: 'economic-times', domains: ['economictimes.indiatimes.com', 'm.economictimes.com'] },
  { id: 'bloomberg', domains: ['bloomberg.com'] },
  { id: 'wall-street-journal', domains: ['wsj.com'] },
  { id: 'barrons', domains: ['barrons.com'] },
  { id: 'investing-com', domains: ['investing.com'] },
  { id: 'mining-com', domains: ['mining.com'] },
  { id: 'coindesk', domains: ['coindesk.com'] },
  { id: 'crypto-briefing', domains: ['cryptobriefing.com'] },
  { id: 'decrypt', domains: ['decrypt.co'] },
  { id: 'blockworks', domains: ['blockworks.co'] },
  { id: 'the-block', domains: ['theblock.co'] },
  { id: 'dl-news', domains: ['dlnews.com'] },
  { id: 'crypto-news', domains: ['crypto.news'] },
  { id: 'fx-news-group', domains: ['fxnewsgroup.com'] },
  { id: 'coingecko', domains: ['coingecko.com'] },
  { id: 'coinmarketcap', domains: ['coinmarketcap.com'] },
  { id: 'alternative-me', domains: ['alternative.me'] },
  { id: 'federal-reserve', domains: ['federalreserve.gov'] },
  { id: 'treasury', domains: ['treasury.gov'] },
  { id: 'bls', domains: ['bls.gov'] },
  { id: 'bea', domains: ['bea.gov'] },
  { id: 'sec', domains: ['sec.gov'] },
  { id: 'cftc', domains: ['cftc.gov'] },
  { id: 'cme', domains: ['cmegroup.com'] },
  { id: 'nyse', domains: ['nyse.com'] },
  { id: 'nasdaq', domains: ['nasdaq.com'] },
  { id: 'sp-global', domains: ['spglobal.com'] },
  { id: 'coinbase', domains: ['coinbase.com'] },
  { id: 'kraken', domains: ['kraken.com'] },
  { id: 'blackrock', domains: ['blackrock.com'] },
  { id: 'fidelity', domains: ['fidelity.com'] },
  { id: 'grayscale', domains: ['grayscale.com'] },
  { id: 'bitcoin', domains: ['bitcoin.org'] },
  { id: 'ethereum', domains: ['ethereum.org'] },
  { id: 'solana', domains: ['solana.com'] }
].map((source) => Object.freeze({ ...source, domains: Object.freeze(source.domains) })));

const ALPHA_VANTAGE_NEWS_PATHS = Object.freeze([
  { id: 'alpha-financial-markets', provider: 'alpha-vantage', pool: 'generalCandidates', topic: 'financial_markets' },
  { id: 'alpha-blockchain', provider: 'alpha-vantage', pool: 'cryptoCandidates', topic: 'blockchain' }
].map((entry) => Object.freeze(entry)));

const STOCKFIT_NEWS_PATHS = Object.freeze([
  { id: 'stockfit-market', provider: 'stockfit', pool: 'generalCandidates', limit: 50 }
].map((entry) => Object.freeze(entry)));

const DIRECT_NEWS_FEEDS = Object.freeze([
  { id: 'investing-market', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_25.rss' },
  { id: 'investing-economy', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_14.rss' },
  { id: 'investing-indicators', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_95.rss' },
  { id: 'investing-earnings', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_1062.rss' },
  { id: 'investing-company', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_356.rss' },
  { id: 'investing-commodities', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investing.com/rss/news_11.rss' },
  { id: 'investing-crypto', provider: 'rss', pool: 'cryptoCandidates', feedUrl: 'https://www.investing.com/rss/news_301.rss' },
  { id: 'axios', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://api.axios.com/feed/' },
  { id: 'kiplinger', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.kiplinger.com/feed/all' },
  { id: 'ibd', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.investors.com/feed/' },
  { id: 'coindesk', provider: 'rss', pool: 'cryptoCandidates', feedUrl: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { id: 'decrypt', provider: 'rss', pool: 'cryptoCandidates', feedUrl: 'https://decrypt.co/feed' },
  { id: 'cnbc', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { id: 'marketwatch', provider: 'rss', pool: 'generalCandidates', feedUrl: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' }
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
