const APPROVED_NEWS_SOURCES = Object.freeze([
  { id: 'ap', domains: ['apnews.com'] },
  { id: 'reuters', domains: ['reuters.com'] },
  { id: 'cnbc', domains: ['cnbc.com'] },
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
  { id: 'bloomberg', domains: ['bloomberg.com'] },
  { id: 'wall-street-journal', domains: ['wsj.com'] },
  { id: 'barrons', domains: ['barrons.com'] },
  { id: 'investing-com', domains: ['investing.com'] },
  { id: 'coindesk', domains: ['coindesk.com'] },
  { id: 'decrypt', domains: ['decrypt.co'] },
  { id: 'blockworks', domains: ['blockworks.co'] },
  { id: 'the-block', domains: ['theblock.co'] },
  { id: 'dl-news', domains: ['dlnews.com'] },
  { id: 'crypto-news', domains: ['crypto.news'] },
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

const GENERAL_SEARCH_PATHS = Object.freeze([
  { id: 'general-market', phase: 'base', query: '("stock market" OR "Wall Street" OR "S&P 500" OR Nasdaq)' },
  { id: 'general-futures', phase: 'base', queryByWindow: {
    morning: '(premarket OR "stock futures" OR "index futures")',
    afternoon: '("market close" OR "after the bell" OR "index futures")'
  } },
  { id: 'general-fed-economy', phase: 'base', query: '("Federal Reserve" OR inflation OR "jobs report" OR "Treasury yields")' },
  { id: 'general-earnings', phase: 'base', query: '(earnings OR guidance OR revenue)' },
  { id: 'general-technology', phase: 'base', query: '(semiconductor OR "artificial intelligence" OR "technology stocks")' },
  { id: 'general-commodities', phase: 'base', query: '("oil prices" OR "crude oil" OR gold OR commodities)' },
  { id: 'general-international', phase: 'base', query: '("global markets" OR "European stocks" OR "Asian stocks" OR geopolitics)' },
  { id: 'general-rates-dollar', phase: 'fallback', query: '("bond market" OR "Treasury market" OR "US dollar")' },
  { id: 'general-financials', phase: 'fallback', query: '(banks OR "financial stocks" OR "credit markets")' },
  { id: 'general-market-structure', phase: 'fallback', query: '(SEC OR exchange OR "market regulation" OR "market structure")' }
].map((path) => Object.freeze(path)));

const CRYPTO_SEARCH_PATHS = Object.freeze([
  { id: 'crypto-market', phase: 'base', query: '(bitcoin OR ethereum OR ether)' },
  { id: 'crypto-etf-flows', phase: 'base', query: '("bitcoin ETF" OR "ether ETF" OR "crypto ETF")' },
  { id: 'crypto-regulation', phase: 'base', query: '("crypto regulation" OR "SEC crypto" OR "stablecoin legislation")' },
  { id: 'crypto-exchanges', phase: 'base', query: '("crypto exchange" OR stablecoin OR custody)' },
  { id: 'crypto-security', phase: 'base', query: '("crypto hack" OR exploit OR "security breach")' },
  { id: 'crypto-protocols', phase: 'base', query: '("blockchain protocol" OR "network upgrade" OR "decentralized finance")' },
  { id: 'crypto-listed-proxies', phase: 'fallback', query: '("crypto stocks" OR Coinbase OR "Strategy bitcoin")' },
  { id: 'crypto-altcoins', phase: 'fallback', query: '(Solana OR XRP OR altcoin)' }
].map((path) => Object.freeze(path)));

function newsSearchPaths(windowMode = '') {
  const resolve = (path, pool) => Object.freeze({
    id: path.id,
    phase: path.phase,
    pool,
    query: path.queryByWindow?.[windowMode] || path.queryByWindow?.morning || path.query
  });
  return Object.freeze([
    ...GENERAL_SEARCH_PATHS.map((path) => resolve(path, 'generalCandidates')),
    ...CRYPTO_SEARCH_PATHS.map((path) => resolve(path, 'cryptoCandidates'))
  ]);
}

module.exports = {
  APPROVED_NEWS_SOURCES,
  CRYPTO_SEARCH_PATHS,
  GENERAL_SEARCH_PATHS,
  newsSearchPaths
};
