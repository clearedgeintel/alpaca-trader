import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { io } from 'socket.io-client'

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || window.location.origin
const SOCKET_PATH = '/ws'

/**
 * Connect to the Socket.io server and invalidate relevant react-query caches
 * when real-time events arrive. This replaces polling for most data.
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

    socket.on('agent:report', () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    })

    socket.on('account:update', () => {
      queryClient.invalidateQueries({ queryKey: ['account'] })
    })

    socket.on('cycle:complete', () => {
      queryClient.invalidateQueries({ queryKey: ['status'] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    })

    return () => {
      socket.disconnect()
    }
  }, [queryClient])

  return socketRef
}
