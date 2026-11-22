import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Shared `GET /health` poll (sidebar status pill, dashboard tile, sign-in footer). */
export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => api.health(),
    retry: false,
    refetchInterval: 60_000,
  });
}
