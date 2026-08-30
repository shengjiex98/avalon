import type {
  AvalonClientAction, OnuwClientAction,
} from '../contracts/actions.ts';
import type { AvalonView, OnuwView, PublicView } from '../contracts/views.ts';

type Translation = (key: string, params?: Record<string, unknown>) => string;
type RenderPlayer = AvalonView['players'][number] | OnuwView['players'][number];

export interface BrowserApp {
  view: PublicView | null;
  server: string | null;
  selection: string[];
  centres: number[];
  infoPopup: string | null;
  muted: boolean;
  lang: string;
  stepEndsAt: number;
  clockStep: number | null;
  seerMode: 'player' | 'centre';
  logOpen: boolean;
}

export type PlayerListOptions = {
  selectable?: boolean;
  selected?: string[];
  onpick?: (player: RenderPlayer) => void;
  tags?: (player: RenderPlayer) => HTMLElement[];
  only?: string[];
  exclude?: string[];
};

type SharedRendererContext = {
  app: BrowserApp;
  T: Translation;
  render: () => void;
  joinNames: (names: string[]) => string;
};

export type AvalonRendererContext = SharedRendererContext & {
  send: (action: AvalonClientAction) => unknown;
  nameOf: (id: string) => string;
  namesOf: (ids: string[]) => string;
  waitingNames: () => string;
  playerList: (options?: PlayerListOptions) => HTMLElement;
};

export type OnuwRendererContext = SharedRendererContext & {
  send: (action: OnuwClientAction) => unknown;
  setMuted?: (value: boolean) => void;
};

export type SharedRenderingContext = {
  app: BrowserApp;
  T: Translation;
  joinNames: (names: string[]) => string;
  currentGame: () => {
    formatParams?: (params: Record<string, unknown>, entryKey: string) => Record<string, unknown>;
  };
};
