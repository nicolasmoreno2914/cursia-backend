// r84 (incidente curso 91): en el VPS de Contabo la ruta IPv6 hacia el borde de Cloudflare de OpenAI pierde
// ~30 % de los paquetes (IPv4 0 %), y Node 22 conecta primero por IPv6 (getaddrinfo devuelve IPv6 antes) →
// cortes ECONNRESET / UND_ERR_SOCKET a mitad del cuerpo del TTS. Este módulo fija el orden de resolución DNS
// de TODO el proceso antes de abrir cualquier conexión: por defecto IPv4 primero (IPv6 sigue disponible como
// respaldo vía happy eyeballs). Se importa como PRIMERA línea de main.ts y de cada worker.
//
// OUTBOUND_DNS_ORDER = ipv4first (defecto) | verbatim (comportamiento anterior) | ipv6first
import * as dns from 'dns';

export const OUTBOUND_DNS_ORDER_ENV = 'OUTBOUND_DNS_ORDER';
export type OutboundDnsOrder = 'ipv4first' | 'verbatim' | 'ipv6first';
const VALID: readonly OutboundDnsOrder[] = ['ipv4first', 'verbatim', 'ipv6first'];

export function resolveOutboundDnsOrder(env: Record<string, string | undefined>): OutboundDnsOrder {
  const v = String(env[OUTBOUND_DNS_ORDER_ENV] ?? '').trim().toLowerCase();
  return (VALID as readonly string[]).includes(v) ? (v as OutboundDnsOrder) : 'ipv4first';
}

export function applyOutboundDnsOrder(env: Record<string, string | undefined> = process.env): OutboundDnsOrder {
  const order = resolveOutboundDnsOrder(env);
  // ipv6first solo existe desde Node 22.1; si el runtime no lo acepta se queda en verbatim (nunca tumba el arranque).
  try {
    dns.setDefaultResultOrder(order as 'ipv4first' | 'verbatim');
  } catch {
    dns.setDefaultResultOrder('verbatim');
    return 'verbatim';
  }
  return order;
}

applyOutboundDnsOrder();
