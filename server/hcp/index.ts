import { HcpCustomersModule } from './customers';
import { HcpEstimatesModule } from './estimates';
import { HcpLeadsModule } from './leads';
import { HcpJobsModule } from './jobs';
import { HcpEmployeesModule } from './employees';
import { HcpSchedulingModule } from './scheduling';
import { HcpServiceItemsModule } from './service-items';

export type {
  HousecallProCustomer,
  HousecallProEmployee,
  HousecallProEstimate,
  HousecallProJob,
  HousecallProResponse,
  HousecallProEvent,
  HcpPageEnvelope,
  HcpDispatchedEmployee,
  HcpEstimateOption,
  HcpEstimateRaw,
} from './types';

export class HousecallProService
  extends HcpCustomersModule
  implements
    Pick<HcpEstimatesModule, 'getEstimates' | 'createEstimate' | 'updateEstimate' | 'updateEstimateOptionSchedule' | 'getEstimate' | 'addEstimateNote'>,
    Pick<HcpLeadsModule, 'createLead' | 'getLead' | 'patchLead' | 'convertLead' | 'getLeadSources'>,
    Pick<HcpJobsModule, 'getJobs' | 'getJob'>,
    Pick<HcpEmployeesModule, 'getEmployees' | 'filterEstimators'>,
    Pick<HcpSchedulingModule, 'getEstimatorAvailability' | 'getEmployeeScheduledEstimates' | 'getEmployeeScheduledJobs' | 'getEmployeeScheduledEvents' | 'calculateAvailableSlots'>,
    Pick<HcpServiceItemsModule, 'getServiceItem'>
{
  private readonly _estimates = new HcpEstimatesModule();
  private readonly _leads = new HcpLeadsModule();
  private readonly _jobs = new HcpJobsModule();
  private readonly _employees = new HcpEmployeesModule();
  private readonly _scheduling = new HcpSchedulingModule();
  private readonly _serviceItems = new HcpServiceItemsModule();

  getEstimates = this._estimates.getEstimates.bind(this._estimates);
  createEstimate = this._estimates.createEstimate.bind(this._estimates);
  updateEstimate = this._estimates.updateEstimate.bind(this._estimates);
  updateEstimateOptionSchedule = this._estimates.updateEstimateOptionSchedule.bind(this._estimates);
  getEstimate = this._estimates.getEstimate.bind(this._estimates);
  addEstimateNote = this._estimates.addEstimateNote.bind(this._estimates);

  createLead = this._leads.createLead.bind(this._leads);
  getLead = this._leads.getLead.bind(this._leads);
  patchLead = this._leads.patchLead.bind(this._leads);
  convertLead = this._leads.convertLead.bind(this._leads);
  getLeadSources = this._leads.getLeadSources.bind(this._leads);

  getJobs = this._jobs.getJobs.bind(this._jobs);
  getJob = this._jobs.getJob.bind(this._jobs);

  getEmployees = this._employees.getEmployees.bind(this._employees);
  filterEstimators = this._employees.filterEstimators.bind(this._employees);

  getEstimatorAvailability = this._scheduling.getEstimatorAvailability.bind(this._scheduling);
  getEmployeeScheduledEstimates = this._scheduling.getEmployeeScheduledEstimates.bind(this._scheduling);
  getEmployeeScheduledJobs = this._scheduling.getEmployeeScheduledJobs.bind(this._scheduling);
  getEmployeeScheduledEvents = this._scheduling.getEmployeeScheduledEvents.bind(this._scheduling);
  calculateAvailableSlots = this._scheduling.calculateAvailableSlots.bind(this._scheduling);

  getServiceItem = this._serviceItems.getServiceItem.bind(this._serviceItems);

  async isConfigured(tenantId: string): Promise<boolean> {
    try {
      await this.getCredentials(tenantId);
      return true;
    } catch (error) {
      return false;
    }
  }

  async checkConnection(tenantId: string): Promise<{ connected: boolean; error?: string }> {
    try {
      const result = await this.getEmployees(tenantId);
      
      if (result.success) {
        return { connected: true };
      } else {
        return {
          connected: false,
          error: result.error || 'Unknown connection error',
        };
      }
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

export const housecallProService = new HousecallProService();
