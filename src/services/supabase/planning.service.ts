import { BaseService } from './base.service';

export class PlanningService extends BaseService {
  async processDueExpenses(): Promise<{ posted: number }> {
    return this.fetch('/rest/v1/rpc/process_planned_expenses', {
      method: 'POST',
      body: JSON.stringify({ p_limit: 100 })
    });
  }
}
