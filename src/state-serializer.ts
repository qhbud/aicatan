import { GameState, Hex, Vertex, Edge } from './types';

export function serializeState(state: GameState): object {
  return {
    ...state,
    hexes:    [...state.hexes.entries()],
    vertices: [...state.vertices.entries()],
    edges:    [...state.edges.entries()],
  };
}

export function deserializeState(data: Record<string, unknown>): GameState {
  return {
    ...(data as Omit<GameState, 'hexes' | 'vertices' | 'edges'>),
    hexes:    new Map(data.hexes    as [string, Hex][]),
    vertices: new Map(data.vertices as [string, Vertex][]),
    edges:    new Map(data.edges    as [string, Edge][]),
    turnSummaries: (data.turnSummaries as GameState['turnSummaries']) ?? [],
  };
}
