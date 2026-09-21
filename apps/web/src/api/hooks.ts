import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiRequest } from './client.js';
import type {
  ActionResultDto,
  AlbumPlan,
  BackupDto,
  CoreSettingsDto,
  DeviceDto,
  DeviceProbeDto,
  DiscoverResponse,
  HealthResponse,
  ModuleDefinitionDto,
  ModuleInstanceDto,
  PlaylistItemDto,
  RestorePlan,
  StatusSummaryDto,
  SubnetsResponse,
  ValidationResponse,
} from './types.js';

export const queryKeys = {
  health: ['health'] as const,
  status: ['status'] as const,
  settings: ['settings'] as const,
  devices: ['devices'] as const,
  device: (id: string) => ['devices', id] as const,
  backups: (id: string) => ['devices', id, 'backups'] as const,
  playlist: (id: string) => ['devices', id, 'playlist'] as const,
  definitions: ['module-definitions'] as const,
  instances: ['module-instances'] as const,
  instance: (id: string) => ['module-instances', id] as const,
  subnets: ['subnets'] as const,
};

export function useHealth(): UseQueryResult<HealthResponse> {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => apiRequest<HealthResponse>('/health'),
  });
}

export function useStatus(): UseQueryResult<StatusSummaryDto> {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: () => apiRequest<StatusSummaryDto>('/status'),
    // The overview is a live operational view; a few seconds of staleness is fine.
    refetchInterval: 5_000,
  });
}

export function useSettings(): UseQueryResult<
  CoreSettingsDto & { themes: Array<{ id: string; displayName: string }> }
> {
  return useQuery({ queryKey: queryKeys.settings, queryFn: () => apiRequest('/settings') });
}

export function useDevices(): UseQueryResult<DeviceDto[]> {
  return useQuery({
    queryKey: queryKeys.devices,
    queryFn: () => apiRequest<DeviceDto[]>('/devices'),
    refetchInterval: 10_000,
  });
}

export function useDevice(id: string | undefined): UseQueryResult<DeviceDto> {
  return useQuery({
    queryKey: queryKeys.device(id ?? ''),
    queryFn: () => apiRequest<DeviceDto>(`/devices/${id}`),
    enabled: Boolean(id),
  });
}

export function useBackups(id: string | undefined): UseQueryResult<BackupDto[]> {
  return useQuery({
    queryKey: queryKeys.backups(id ?? ''),
    queryFn: () => apiRequest<BackupDto[]>(`/devices/${id}/backups`),
    enabled: Boolean(id),
  });
}

export function usePlaylist(id: string | undefined): UseQueryResult<PlaylistItemDto[]> {
  return useQuery({
    queryKey: queryKeys.playlist(id ?? ''),
    queryFn: () => apiRequest<PlaylistItemDto[]>(`/devices/${id}/playlist`),
    enabled: Boolean(id),
  });
}

export function useModuleDefinitions(): UseQueryResult<ModuleDefinitionDto[]> {
  return useQuery({
    queryKey: queryKeys.definitions,
    queryFn: () => apiRequest<ModuleDefinitionDto[]>('/module-definitions'),
  });
}

export function useModuleInstances(): UseQueryResult<ModuleInstanceDto[]> {
  return useQuery({
    queryKey: queryKeys.instances,
    queryFn: () => apiRequest<ModuleInstanceDto[]>('/module-instances'),
    refetchInterval: 15_000,
  });
}

export function useModuleInstance(id: string | undefined): UseQueryResult<ModuleInstanceDto> {
  return useQuery({
    queryKey: queryKeys.instance(id ?? ''),
    queryFn: () => apiRequest<ModuleInstanceDto>(`/module-instances/${id}`),
    enabled: Boolean(id),
  });
}

export function useSubnets(): UseQueryResult<SubnetsResponse> {
  return useQuery({
    queryKey: queryKeys.subnets,
    queryFn: () => apiRequest<SubnetsResponse>('/devices/subnets'),
  });
}

/** Invalidates everything that can change after a device or module mutation. */
export function useInvalidateAll(): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.status }),
      client.invalidateQueries({ queryKey: queryKeys.devices }),
      client.invalidateQueries({ queryKey: queryKeys.instances }),
      client.invalidateQueries({ queryKey: queryKeys.definitions }),
    ]);
  };
}

export function useProbeDevice(): UseMutationResult<DeviceProbeDto, Error, { host: string }> {
  return useMutation({
    mutationFn: ({ host }) =>
      apiRequest<DeviceProbeDto>('/devices/probe', { method: 'POST', body: { host } }),
  });
}

export function useDiscoverDevices(): UseMutationResult<DiscoverResponse, Error, { cidr: string }> {
  return useMutation({
    mutationFn: ({ cidr }) =>
      apiRequest<DiscoverResponse>('/devices/discover', { method: 'POST', body: { cidr } }),
  });
}

export function useAddDevice(): UseMutationResult<
  DeviceDto,
  Error,
  { host: string; name?: string }
> {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (body) => apiRequest<DeviceDto>('/devices', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateDevice(
  id: string,
): UseMutationResult<DeviceDto, Error, Record<string, unknown>> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiRequest<DeviceDto>(`/devices/${id}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.devices });
      await client.invalidateQueries({ queryKey: queryKeys.device(id) });
    },
  });
}

export function useDeleteDevice(): UseMutationResult<void, Error, { id: string }> {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: ({ id }) => apiRequest<void>(`/devices/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function useDeviceAction(
  id: string,
): UseMutationResult<Record<string, unknown>, Error, { action: string; body?: unknown }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ action, body }) =>
      apiRequest<Record<string, unknown>>(`/devices/${id}/${action}`, {
        method: 'POST',
        body: body ?? {},
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.device(id) });
      await client.invalidateQueries({ queryKey: queryKeys.devices });
      await client.invalidateQueries({ queryKey: queryKeys.status });
    },
  });
}

export function useAlbumPlan(): UseMutationResult<AlbumPlan, Error, { deviceId: string }> {
  return useMutation({
    mutationFn: ({ deviceId }) => apiRequest<AlbumPlan>(`/devices/${deviceId}/takeover-album/plan`),
  });
}

export function useRestorePlan(): UseMutationResult<
  RestorePlan,
  Error,
  { deviceId: string; backupId: string }
> {
  return useMutation({
    mutationFn: ({ deviceId, backupId }) =>
      apiRequest<RestorePlan>(`/devices/${deviceId}/restore/${backupId}/plan`),
  });
}

export function useCreateInstance(): UseMutationResult<
  ModuleInstanceDto,
  Error,
  { moduleId: string; name?: string; settings?: Record<string, unknown> }
> {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (body) =>
      apiRequest<ModuleInstanceDto>('/module-instances', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateInstance(id: string): UseMutationResult<
  ModuleInstanceDto,
  Error,
  {
    name?: string;
    enabled?: boolean;
    settings?: Record<string, unknown>;
    secrets?: Record<string, string | null>;
  }
> {
  const client = useQueryClient();
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (body) =>
      apiRequest<ModuleInstanceDto>(`/module-instances/${id}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.instance(id) });
      await invalidate();
    },
  });
}

export function useDeleteInstance(): UseMutationResult<void, Error, { id: string }> {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: ({ id }) =>
      apiRequest<void>(`/module-instances/${id}`, { method: 'DELETE', body: { confirm: true } }),
    onSuccess: invalidate,
  });
}

export function useValidateInstance(
  id: string,
): UseMutationResult<ValidationResponse, Error, Record<string, unknown>> {
  return useMutation({
    mutationFn: (settings) =>
      apiRequest<ValidationResponse>(`/module-instances/${id}/validate`, {
        method: 'POST',
        body: { settings },
      }),
  });
}

export function useRunModuleAction(
  id: string,
): UseMutationResult<
  ActionResultDto,
  Error,
  { actionId: string; input?: unknown; confirm?: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ actionId, input, confirm }) =>
      apiRequest<ActionResultDto>(`/module-instances/${id}/actions/${actionId}`, {
        method: 'POST',
        body: { input: input ?? {}, ...(confirm ? { confirm: true } : {}) },
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.instance(id) });
      await client.invalidateQueries({ queryKey: queryKeys.instances });
    },
  });
}

export function useRefreshInstance(id: string): UseMutationResult<ModuleInstanceDto, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest<ModuleInstanceDto>(`/module-instances/${id}/refresh`, { method: 'POST' }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.instance(id) });
      await client.invalidateQueries({ queryKey: queryKeys.status });
    },
  });
}

export function useSavePlaylist(
  deviceId: string,
): UseMutationResult<PlaylistItemDto[], Error, { items: Array<Partial<PlaylistItemDto>> }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      apiRequest<PlaylistItemDto[]>(`/devices/${deviceId}/playlist`, { method: 'PUT', body }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.playlist(deviceId) });
      await client.invalidateQueries({ queryKey: queryKeys.status });
    },
  });
}

export function useSaveSettings(): UseMutationResult<
  CoreSettingsDto,
  Error,
  Partial<CoreSettingsDto>
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiRequest<CoreSettingsDto>('/settings', { method: 'PATCH', body }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.settings });
      await client.invalidateQueries({ queryKey: queryKeys.status });
    },
  });
}
