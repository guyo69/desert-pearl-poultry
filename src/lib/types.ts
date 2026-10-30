// Shapes returned by the `dashboard` database function.
export type Role = 'owner' | 'manager' | 'clerk' | 'pos';
export type Item = 'N' | 'C' | 'J';
export interface Q { n: number; c: number; j: number }

export interface Settings {
  tray_n: number; pc_n: number; tray_c: number; pc_j: number;
  feed_buffer_kg: number; bag_kg: number; bag_price: number;
  tank_capacity_l: number; water_drop_pct: number; water_ratio_min: number; water_ratio_max: number;
  cash_tol: number; unbanked_max: number; break_tol: number; lay_drop_pts: number;
  timezone: string; go_live: string | null;
}
export interface Location { id: string; name: string; short: string; kind: 'farm' | 'van' | 'shop'; sort: number }
export interface Account { id: string; name: string; kind: 'cash' | 'till' | 'paybill' | 'bank'; location_id: string | null; sort: number }
export interface House { id: string; name: string; birds_at_start: number; start_date: string; age_weeks_at_start: number; expected_lay: number; active: boolean; sort: number }
export interface Medicine { id: number; name: string; unit: string; reorder: number; active: boolean; stock: number }
export interface ScheduleItem { id: number; due: string; house: string; task: string; done: boolean }
/** Everyone gets names and roles; only management also gets the account-security fields. */
export interface StaffLite { id: string; display_name: string; role: Role; location_id: string | null; active: boolean; username?: string; must_change_password?: boolean; mfa_enabled?: boolean; locked?: boolean }
/** The owner's staff tool (staff-admin "list"). */
export interface StaffAdminRow extends StaffLite { username: string; must_change_password: boolean; temp_expires_at: string | null; password_changed_at: string | null; mfa_enabled: boolean; mfa_required: boolean; locked_until: string | null; created_at: string }
export interface Me { id: string; display_name: string; role: Role; location_id: string | null; username: string; password_changed_at: string | null; mfa_enabled: boolean; mfa_required: boolean; backup_codes_left: number }

export type StockKind = 'coll' | 'out' | 'recv' | 'sold' | 'brk' | 'adj';
export interface StockRow extends Q { location_id: string }
export interface StockDaily extends Q { location_id: string; d: string; kind: StockKind }
export interface Balance { account_id: string; balance: number }
export type MoneyKind = 'sale' | 'move_in' | 'move_out' | 'fee' | 'expense' | 'variance' | 'opening';
export interface MoneyDaily { account_id: string; d: string; kind: MoneyKind; amount: number }
export interface SalesDaily extends Q { location_id: string; d: string; cnt: number; value: number; cash: number; till: number; paybill: number }
export interface BreakageDaily { location_id: string; d: string; transit: boolean; qty: number }
export interface ReceivedDaily { location_id: string; d: string; sent: number; recv: number }
export interface FarmDaily extends Q { house_id: string; d: string; deaths: number; hens: number }
export interface FeedDaily { d: string; kind: 'in' | 'use' | 'adjust'; kg: number }
export interface WaterDaily { d: string; house_id: string; litres: number }
export interface Transfer {
  id: number; d: string; recorded_at: string; from_loc: string; to_loc: string;
  sent_n: number; sent_c: number; sent_j: number; status: 'in_transit' | 'received'; note: string | null;
}
export interface StockCount { id: number; location_id: string; kind: 'open' | 'close' | 'opening_balance'; recorded_at: string; cnt_n: number; cnt_c: number; cnt_j: number; adj_n: number; adj_c: number; adj_j: number }
export interface CashCount { id: number; location_id: string; counted: number; expected: number; diff: number; recorded_at: string }
export interface Notice { id: number; created_at: string; sev: Sev; title: string; body: string; to_roles: Role[]; location_id: string | null; kind: string | null; read: boolean }
export type Sev = 'red' | 'orange' | 'amber' | 'info';

export interface Dashboard {
  today: string; from: string; server_time: string;
  me: Me; settings: Settings;
  locations: Location[]; accounts: Account[]; houses: House[]; medicines: Medicine[]; schedule: ScheduleItem[]; staff: StaffLite[];
  stock: StockRow[]; stock_daily: StockDaily[];
  balances: Balance[]; money_daily: MoneyDaily[];
  sales_daily: SalesDaily[]; breakage_daily: BreakageDaily[]; received_daily: ReceivedDaily[];
  farm_daily: FarmDaily[]; feed_daily: FeedDaily[]; feed_stock: number;
  water_daily: WaterDaily[]; tank: { litres: number; recorded_at: string; d: string } | null; tank_daily: { d: string; litres: number }[];
  transit: Transfer[]; counts_today: StockCount[]; cash_counts_today: CashCount[];
  notifications: Notice[];
}

export interface ActivityRow {
  kind: 'collect' | 'mort' | 'feed' | 'water' | 'med' | 'xfer' | 'sale' | 'brk' | 'count' | 'money' | 'cash';
  id: number; d: string; recorded_at: string; by_name: string | null; by_role: Role | null;
  location_id: string | null; voided: boolean; data: Record<string, any>;
}
