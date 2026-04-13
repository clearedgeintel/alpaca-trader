import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { io } from 'socket.io-client'

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || window.location.origin
const SOCKET_PATH = '/ws'

// Shared state for real-time market prices — components can import this
export const livePrices = {}

// Order event listeners
const orderListeners = new Set()
export function onOrderUpdate(cb) {
  orderListeners.add(cb)
  return () => orderListeners.delete(cb)
}

// Live agent activity feed — stores last 50 reports
export const agentActivity = { items: [], listeners: new Set() }
function pushAgentActivity(item) {
  agentActivity.items = [item, ...agentActivity.items.slice(0, 49)]
  for (const cb of agentActivity.listeners) { try { cb(agentActivity.items) } catch {} }
}
export function onAgentActivity(cb) {
  agentActivity.listeners.add(cb)
  cb(agentActivity.items)
  return () => agentActivity.listeners.delete(cb)
}

/**
 * Connect to the Socket.io server and invalidate relevant react-query caches
 * when real-time events arrive.
 */
export function useSocket() {
  const queryClient = useQueryClient()
  const socketRef = useRef(null)

  useEffect(() => {
    const socket = io(SOCKET_URL, { path: SOCKET_PATH, transports: ['websocket', 'polling'] })
    socketRef.current = socket

    socket.on('trade:update', () => {
      queryClient.invalidateQueries({ queryKey: ['trades'] })
      queryClient.invalidateQueries({ queryKey: ['positions'] })
    })

    socket.on('trade:closed', () => {
      queryClient.invalidateQueries({ queryKey: ['trades'] })
      queryClient.invalidateQueries({ queryKey: ['positions'] })
      queryClient.invalidateQueries({ queryKey: ['performance'] })
      queryClient.invalidateQueries({ queryKey: ['analytics'] })
    })

    socket.on('signal:detected', () => {
      queryClient.invalidateQueries({ queryKey: ['signals'] })
    })

    socket.on('decision:made', () => {
      queryClient.invalidateQueries({ queryKey: ['decisions'] })
      queryClient.invalidateQueries({ queryKey: ['decision-timeline'] })
    })

    socket.on('agent:report', (data) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      // Push into live activity feed
      if (data?.agent && data?.report) {
        pushAgentActivity({
          id: `${data.agent}-${Date.now()}-${Math.random()}`,
          agent: data.agent,
          ...data.report,
          receivedAt: Date.now(),
        })
      }
    })

    socket.on('account:update', () => {
      queryClient.invalidateQueries({ queryKey: ['account'] })
    })

    socket.on('cycle:complete', () => {
      queryClient.invalidateQueries({ queryKey: ['status'] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    })

    // Real-time market data from Alpaca websocket
    socket.on('market:trade', (data) => {
      livePrices[data.symbol] = {
        price: data.price,
        timestamp: data.timestamp,
        updated: Date.now(),
      }
    })

    socket.on('market:bar', (data) => {
      livePrices[data.symbol] = {
        price: data.close,
        open: data.open,
        high: data.high,
        low: data.low,
        volume: data.volume,
        timestamp: data.timestamp,
        updated: Date.now(),
      }
      // Refresh tickers when we get a new bar
      queryClient.invalidateQueries({ queryKey: ['market-tickers'] })
    })

    // Order fill/cancel notifications from Alpaca websocket
    socket.on('order:update', (data) => {
      for (const cb of orderListeners) {
        try { cb(data) } catch {}
      }
      // Refresh positions and trades on fills
      if (data.event === 'fill' || data.event === 'partial_fill') {
        queryClient.invalidateQueries({ queryKey: ['positions'] })
        queryClient.invalidateQueries({ queryKey: ['trades'] })
        queryClient.invalidateQueries({ queryKey: ['account'] })
      }
    })

    return () => {
      socket.disconnect()
    }
  }, [queryClient])

  return socketRef
}
