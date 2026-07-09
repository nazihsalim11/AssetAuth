/**
 * Notification templates.
 *
 * One entry per event type, rendering the same event for all three channels so the
 * wording cannot drift between them. Each template returns:
 *
 *   type    - severity, drives the in-app dot colour ('info' | 'warning' | 'error')
 *   subject - email subject line
 *   inApp   - short text for the bell popover
 *   email   - full body
 *   sms     - terse body; SMS is billed per 160 characters, so keep it tight
 *
 * `ctx` is the event payload assembled by the caller.
 */

const fmtDate = (value) => {
  if (!value) return 'an unknown date';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().split('T')[0];
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const templates = {
  'ticket.created': (c) => ({
    type: c.priority === 'Critical' ? 'error' : c.priority === 'Medium' ? 'warning' : 'info',
    subject: `[${c.ticketId}] New ${c.priority} ticket: ${c.subject}`,
    inApp: `New ${c.priority} ticket ${c.ticketId} in ${c.department}: "${c.subject}"`,
    email:
      `A new ticket has been raised.\n\n` +
      `Ticket:      ${c.ticketId}\n` +
      `Subject:     ${c.subject}\n` +
      `Department:  ${c.department}\n` +
      `Priority:    ${c.priority}\n` +
      `Raised by:   ${c.createdByName}\n` +
      `SLA due:     ${fmtDate(c.slaDeadline)}\n\n` +
      `${c.description || ''}\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: new ${c.priority} ticket ${c.ticketId} (${c.department}) - ${c.subject}`
  }),

  'ticket.assigned': (c) => ({
    type: 'info',
    subject: `[${c.ticketId}] Assigned to ${c.assignedToName}`,
    inApp: `Ticket ${c.ticketId} assigned to ${c.assignedToName}`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") has been assigned to ${c.assignedToName}.\n\n` +
      `Priority: ${c.priority}\nSLA due:  ${fmtDate(c.slaDeadline)}\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} assigned to ${c.assignedToName}`
  }),

  'ticket.status_changed': (c) => ({
    type: 'info',
    subject: `[${c.ticketId}] Status changed to ${c.status}`,
    inApp: `Ticket ${c.ticketId} moved from ${c.previousStatus} to ${c.status}`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") changed status.\n\n` +
      `Previous: ${c.previousStatus}\nCurrent:  ${c.status}\nUpdated by: ${c.actorName}\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} is now ${c.status}`
  }),

  'ticket.priority_changed': (c) => ({
    type: c.priority === 'Critical' ? 'error' : 'info',
    subject: `[${c.ticketId}] Priority changed to ${c.priority}`,
    inApp: `Ticket ${c.ticketId} priority changed from ${c.previousPriority} to ${c.priority}`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") changed priority.\n\n` +
      `Previous: ${c.previousPriority}\nCurrent:  ${c.priority}\nUpdated by: ${c.actorName}\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} priority is now ${c.priority}`
  }),

  'ticket.reopened': (c) => ({
    type: 'warning',
    subject: `[${c.ticketId}] Reopened`,
    inApp: `Ticket ${c.ticketId} has been reopened`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") was reopened by ${c.actorName} after being ${c.previousStatus}.\n\n` +
      `Recommended action: review the original resolution and continue work.\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} reopened`
  }),

  'ticket.resolved': (c) => ({
    type: 'info',
    subject: `[${c.ticketId}] Resolved`,
    inApp: `Ticket ${c.ticketId} has been resolved`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") has been marked resolved by ${c.actorName}.\n\n` +
      `If the issue persists, reopen the ticket from the service desk.\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} resolved`
  }),

  'ticket.closed': (c) => ({
    type: 'info',
    subject: `[${c.ticketId}] Closed`,
    inApp: `Ticket ${c.ticketId} has been closed`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") has been closed by ${c.actorName}.\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} closed`
  }),

  'ticket.escalated': (c) => ({
    type: 'error',
    subject: `[${c.ticketId}] ESCALATED — SLA breached`,
    inApp: `Ticket ${c.ticketId} escalated: SLA breached ${plural(c.hoursOverdue, 'hour')} ago`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") has breached its SLA and been escalated.\n\n` +
      `Department: ${c.department}\n` +
      `Priority:   ${c.priority}\n` +
      `Assigned:   ${c.assignedToName || 'Unassigned'}\n` +
      `SLA due:    ${fmtDate(c.slaDeadline)}\n` +
      `Overdue by: ${plural(c.hoursOverdue, 'hour')}\n\n` +
      `Recommended action: reassign or prioritise this ticket immediately.\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} ESCALATED, SLA breached by ${plural(c.hoursOverdue, 'hour')}`
  }),

  'ticket.sla_approaching': (c) => ({
    type: 'warning',
    subject: `[${c.ticketId}] SLA due in ${plural(c.hoursRemaining, 'hour')}`,
    inApp: `Ticket ${c.ticketId} SLA due in ${plural(c.hoursRemaining, 'hour')}`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") is approaching its SLA deadline.\n\n` +
      `Assigned:  ${c.assignedToName || 'Unassigned'}\n` +
      `SLA due:   ${fmtDate(c.slaDeadline)}\n` +
      `Remaining: ${plural(c.hoursRemaining, 'hour')}\n\n` +
      `Recommended action: resolve or reassign before the deadline.\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} SLA due in ${plural(c.hoursRemaining, 'hour')}`
  }),

  'ticket.sla_breached': (c) => ({
    type: 'error',
    subject: `[${c.ticketId}] SLA BREACHED`,
    inApp: `Ticket ${c.ticketId} has breached its SLA`,
    email:
      `Ticket ${c.ticketId} ("${c.subject}") has passed its SLA deadline of ${fmtDate(c.slaDeadline)}.\n\n` +
      `Assigned: ${c.assignedToName || 'Unassigned'}\n\n— AssetFlow Service Desk`,
    sms: `AssetFlow: ticket ${c.ticketId} SLA BREACHED`
  }),

  'asset.warranty_expiring': (c) => ({
    type: 'warning',
    subject: `Warranty expiring in ${plural(c.daysRemaining, 'day')}: ${c.assetId}`,
    inApp: `Warranty for ${c.assetId} (${c.assetName}) expires in ${plural(c.daysRemaining, 'day')}`,
    email:
      `An asset warranty is approaching expiry.\n\n` +
      `Asset ID:        ${c.assetId}\n` +
      `Asset name:      ${c.assetName}\n` +
      `Serial number:   ${c.serialNumber || 'N/A'}\n` +
      `Warranty expiry: ${fmtDate(c.expiryDate)}\n` +
      `Remaining:       ${plural(c.daysRemaining, 'day')}\n` +
      `Assigned to:     ${c.assignedEmployee || 'Unassigned (in inventory)'}\n` +
      `Department:      ${c.department || 'N/A'}\n\n` +
      `Recommended action: raise a renewal request with the vendor, or plan replacement ` +
      `before the warranty lapses.\n\n— AssetFlow Monitoring`,
    sms: `AssetFlow: warranty for ${c.assetId} expires in ${plural(c.daysRemaining, 'day')} (${fmtDate(c.expiryDate)})`
  }),

  'amc.expiring': (c) => ({
    type: 'warning',
    subject: `AMC expiring in ${plural(c.daysRemaining, 'day')}: ${c.amcId}`,
    inApp: `AMC ${c.amcId} with ${c.vendor} expires in ${plural(c.daysRemaining, 'day')}`,
    email:
      `An AMC contract is approaching expiry.\n\n` +
      `Contract ID:  ${c.amcId}\n` +
      `Vendor:       ${c.vendor}\n` +
      `Expiry date:  ${fmtDate(c.expiryDate)}\n` +
      `Remaining:    ${plural(c.daysRemaining, 'day')}\n` +
      `Assets under contract: ${c.assetCount}\n` +
      `${c.assetSummary ? `Covered assets: ${c.assetSummary}\n` : ''}` +
      `\nRecommended action: begin renewal negotiation with ${c.vendor}, or arrange ` +
      `alternative cover before the contract lapses.\n\n— AssetFlow Contract Engine`,
    sms: `AssetFlow: AMC ${c.amcId} (${c.vendor}) expires in ${plural(c.daysRemaining, 'day')}`
  })
};

/** Renders one event. Throws on an unknown type rather than silently sending nothing. */
function render(eventType, ctx) {
  const template = templates[eventType];
  if (!template) throw new Error(`No notification template for event type "${eventType}"`);
  return template(ctx);
}

module.exports = { render, eventTypes: Object.keys(templates) };
