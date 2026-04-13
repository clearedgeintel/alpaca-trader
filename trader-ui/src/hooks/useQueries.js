import { useQuery, useIsFetching } from '@tanstack/react-query'
import {
  getStatus, getAccount, getPositions, getTrades, getSignals, getPerformance,
  getAgents, getDecisions, getRegimeReport, getNewsReport, getOrchestratorReport,
  getTechnicalReport, getExecutionFills, getScreenerReport, getAnalytics,
  getDecisionTimeline, getMetricsSummary, getMetricsLeaderboard, getMetricsLatency,
  getMarketTickers, getMarketNews, getMarketBars, getMarketSnapshot, getMarketUniverse,
} from '../api/client'

export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: getStatus,
    refetchInterval: 15000,
    staleTime: 10000,
  })
}

export function useAccount() {
  return useQuery({
    queryKey: ['account'],
    queryFn: getAccount,
    refetchInterval: 30000,
    staleTime: 20000,
  })
}

export function usePositions() {
  return useQuery({
    queryKey: ['positions'],
    queryFn: getPositions,
    refetchInterval: 30000,
    staleTime: 20000,
  })
}

export function useOpenTrades() {
  return useQuery({
    queryKey: ['trades', 'open'],
    queryFn: () => getTrades({ status: 'open' }),
    refetchInterval: 30000,
    staleTime: 20000,
  })
}

export function useAllTrades(params = {}) {
  return useQuery({
    queryKey: ['trades', 'all', params],
    queryFn: () => getTrades(params),
    refetchInterval: 60000,
    staleTime: 30000,
  })
}

export function useSignals(limit = 50) {
  return useQuery({
    queryKey: ['signals', limit],
    queryFn: () => getSignals(limit),
    refetchInterval: 60000,
    staleTime: 30000,
  })
}

export function usePerformance() {
  return useQuery({
    queryKey: ['performance'],
    queryFn: getPerformance,
    refetchInterval: 120000,
    staleTime: 60000,
  })
}

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: getAgents,
    refetchInterval: 15000,
    staleTime: 10000,
  })
}

export function useDecisions(limit = 20) {
  return useQuery({
    queryKey: ['decisions', limit],
    queryFn: () => getDecisions(limit),
    refetchInterval: 30000,
    staleTime: 15000,
  })
}

export function useRegimeReport() {
  return useQuery({
    queryKey: ['regime-report'],
    queryFn: getRegimeReport,
    refetchInterval: 60000,
    staleTime: 30000,
  })
}

export function useNewsReport() {
  return useQuery({
    queryKey: ['news-report'],
    queryFn: getNewsReport,
    refetchInterval: 60000,
    staleTime: 30000,
  })
}

export function useOrchestratorReport() {
  return useQuery({
    queryKey: ['orchestrator-report'],
    queryFn: getOrchestratorReport,
    refetchInterval: 30000,
    staleTime: 15000,
  })
}

export function useTechnicalReport() {
  return useQuery({
    queryKey: ['technical-report'],
    queryFn: () => getTechnicalReport(),
    refetchInterval: 60000,
    staleTime: 30000,
  })
}

export function useExecutionFills(limit = 20) {
  return useQuery({
    queryKey: ['execution-fills', limit],
    queryFn: () => getExecutionFills(limit),
    refetchInterval: 30000,
    staleTime: 15000,
  })
}

export function useScreenerReport() {
  return useQuery({
    queryKey: ['screener-report'],
    queryFn: getScreenerReport,
    refetchInterval: 60000,
    staleTime: 30000,
  })
}

export function useAnalytics() {
  return useQuery({
    queryKey: ['analytics'],
    queryFn: getAnalytics,
    refetchInterval: 120000,
    staleTime: 60000,
  })
}

export function useDecisionTimeline(limit = 50) {
  return useQuery({
    queryKey: ['decision-timeline', limit],
    queryFn: () => getDecisionTimeline(limit),
    refetchInterval: 60000,
    staleTime: 30000,
  })
}

export function useMetricsSummary(days = 7) {
  return useQuery({
    queryKey: ['metrics-summary', days],
    queryFn: () => getMetricsSummary(days),
    refetchInterval: 60000,
    staleTime: 30000,
  })
}

export function useMetricsLeaderboard(days = 30) {
  return useQuery({
    queryKey: ['metrics-leaderboard', days],
    queryFn: () => getMetricsLeaderboard(days),
    refetchInterval: 120000,
    staleTime: 60000,
  })
}

export function useMetricsLatency(hours = 24) {
  return useQuery({
    queryKey: ['metrics-latency', hours],
    queryFn: () => getMetricsLatency(hours),
    refetchInterval: 60000,
    staleTime: 30000,
  })
}

export function useMarketTickers() {
  return useQuery({
    queryKey: ['market-tickers'],
    queryFn: getMarketTickers,
    refetchInterval: 15000,
    staleTime: 10000,
  })
}

export function useMarketNews(limit = 15) {
  return useQuery({
    queryKey: ['market-news', limit],
    queryFn: () => getMarketNews(limit),
    refetchInterval: 60000,
    staleTime: 30000,
  })
}

export function useMarketBars(symbol, timeframe = '1Day', limit = 100) {
  return useQuery({
    queryKey: ['market-bars', symbol, timeframe, limit],
    queryFn: () => getMarketBars(symbol, timeframe, limit),
    enabled: !!symbol,
    staleTime: 30000,
  })
}

export function useMarketSnapshot(symbol) {
  return useQuery({
    queryKey: ['market-snapshot', symbol],
    queryFn: () => getMarketSnapshot(symbol),
    enabled: !!symbol,
    refetchInterval: 15000,
    staleTime: 10000,
  })
}

export function useMarketUniverse() {
  return useQuery({
    queryKey: ['market-universe'],
    queryFn: getMarketUniverse,
    refetchInterval: 60000,
    staleTime: 30000,
  })
}

export function useIsAnyFetching() {
  return useIsFetching() > 0
}
