import { BaseService } from './base.service';

export class DocumentOcrReservationError extends Error {
  constructor(
    readonly code: 'CLOUD_PDF_BUDGET_EXCEEDED' | 'CLOUD_PDF_CLAIM_UNAVAILABLE',
    readonly status: number
  ) {
    super('OCR reservation rejected');
  }
}

/** Private service-role budget ledger; reservations remain charged if settlement fails. */
export class DocumentOcrService extends BaseService {
  async reserve(
    userId: string,
    documentId: string,
    claimToken: string,
    amountMicros: number,
    dailyLimitMicros: number
  ): Promise<string> {
    try {
      return await this.fetch<string>('/rest/v1/rpc/reserve_document_ocr_budget', {
        method: 'POST',
        body: JSON.stringify({
          p_user_id: userId,
          p_document_id: documentId,
          p_claim_token: claimToken,
          p_amount_micros: amountMicros,
          p_daily_limit_micros: dailyLimitMicros
        })
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('OCR budget exhausted'))
        throw new DocumentOcrReservationError('CLOUD_PDF_BUDGET_EXCEEDED', 429);
      if (
        error instanceof Error &&
        (error.message.includes('Document claim unavailable') ||
          error.message.includes('document_ocr_budget_reservations_document_id_claim_token_key'))
      )
        throw new DocumentOcrReservationError('CLOUD_PDF_CLAIM_UNAVAILABLE', 409);
      throw error;
    }
  }
  async settle(reservationId: string, actualMicros: number | null): Promise<void> {
    await this.fetch('/rest/v1/rpc/settle_document_ocr_budget', {
      method: 'POST',
      body: JSON.stringify({ p_reservation_id: reservationId, p_actual_micros: actualMicros })
    });
  }
}
