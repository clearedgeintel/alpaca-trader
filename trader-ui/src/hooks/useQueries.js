import { useQuery, useIsFetching } from '@tanstack/react-query'
import { getStatus, getAccount, getPositions, getTrades, getSignals, getPerformance } from '../api/client'

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

export function useIsAnyFetching() {
  return useIsFetching() > 0
}
