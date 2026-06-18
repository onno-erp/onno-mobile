// A hand-written DivKit document shaped like what the Onno server's
// `SurfaceDivBuilder` emits — ported from the Flutter client's
// `sample_cards.dart`. Used to prove the RN renderer draws and dispatches
// before the live API is wired up. Adds a `@{…}` expression and an `onno-icon`
// custom to exercise the expression engine and the custom registry.

import type { DivBlock, DivCardEnvelope } from './types';

function row(number: string, date: string, status: string, url: string): DivBlock {
  const cell = (text: string, muted = false): DivBlock => ({
    type: 'text',
    text,
    font_size: 14,
    width: { type: 'match_parent', weight: 1 },
    ...(muted ? { text_color: '#FF6B7280' } : {}),
  });
  return {
    type: 'container',
    orientation: 'horizontal',
    paddings: { top: 10, bottom: 10 },
    action: { log_id: 'open', url },
    items: [cell(number), cell(date, true), cell(status)],
  };
}

export function sampleDocumentListCard(): DivCardEnvelope {
  return {
    templates: {},
    card: {
      log_id: 'onno-document-list',
      variables: [{ type: 'integer', name: 'count', value: 3 }],
      states: [
        {
          state_id: 0,
          div: {
            type: 'container',
            orientation: 'vertical',
            paddings: { left: 16, right: 16, top: 16, bottom: 16 },
            items: [
              {
                type: 'container',
                orientation: 'horizontal',
                content_alignment_vertical: 'center',
                items: [
                  { type: 'custom', custom_type: 'onno-icon', custom_props: { name: 'Book', size: 22 } },
                  {
                    type: 'container',
                    orientation: 'vertical',
                    paddings: { left: 8 },
                    items: [
                      { type: 'text', text: 'Bookings', font_size: 22, font_weight: 'bold' },
                      // expression: pluralized count pulled from a card variable
                      {
                        type: 'text',
                        text: '@{count} document@{count == 1 ? \'\' : \'s\'}',
                        font_size: 13,
                        text_color: '#FF6B7280',
                      },
                    ],
                  },
                ],
              },
              { type: 'separator', margins: { top: 12, bottom: 4 } },
              row('SO-0001', '2026-05-30', 'Posted', 'onno://documents/booking/1'),
              { type: 'separator' },
              row('SO-0002', '2026-05-31', 'Draft', 'onno://documents/booking/2'),
              { type: 'separator' },
              row('SO-0003', '2026-06-01', 'Draft', 'onno://documents/booking/3'),
            ],
          },
        },
      ],
    },
  };
}
