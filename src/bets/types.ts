export interface Bet {
  externalBetId: string;
  placedAt?: string | null;
  status?: string | null;
  stake?: number | null;
  potentialPayout?: number | null;
  selections?: object | null;
  raw?: object | null;
}
