import { v4 as uuidv4 } from 'uuid';

export interface KycFieldConfig {
  id: string;
  name: string;
  label: string;
  type: 'text' | 'date' | 'phone' | 'select' | 'file' | 'camera' | 'checkbox';
  required: boolean;
  options?: string[]; // for select type
  hint?: string;
}

export interface KycStepConfig {
  id: string;
  stepNumber: number;
  slug: string;
  title: string;
  description: string;
  icon: string;
  enabled: boolean;
  fields: KycFieldConfig[];
}

const defaultSteps: KycStepConfig[] = [
  {
    id: 'step-1',
    stepNumber: 1,
    slug: 'personal',
    title: 'Personal Information',
    description: 'Legal identity details exactly as they appear on your government ID.',
    icon: 'User',
    enabled: true,
    fields: [
      { id: 'f-1', name: 'firstName', label: 'First Name', type: 'text', required: true, hint: 'As on your ID' },
      { id: 'f-2', name: 'lastName', label: 'Last Name', type: 'text', required: true, hint: 'As on your ID' },
      { id: 'f-3', name: 'dateOfBirth', label: 'Date of Birth', type: 'date', required: true, hint: 'Must be 18+' },
      { id: 'f-4', name: 'phone', label: 'Phone Number', type: 'phone', required: true, hint: 'International format' },
      { id: 'f-5', name: 'nationality', label: 'Nationality', type: 'select', required: true },
      { id: 'f-6', name: 'country', label: 'Country of Residence', type: 'select', required: true },
      { id: 'f-7', name: 'address', label: 'Residential Address', type: 'text', required: false },
    ],
  },
  {
    id: 'step-2',
    stepNumber: 2,
    slug: 'document',
    title: 'Identity Document',
    description: 'Upload a valid Passport, National ID, or Driving License.',
    icon: 'FileText',
    enabled: true,
    fields: [
      { id: 'f-9', name: 'doc_front', label: 'Front Side', type: 'file', required: true },
      { id: 'f-10', name: 'doc_back', label: 'Back Side', type: 'file', required: false, hint: 'Required for National ID & Driving License' },
    ],
  },
  {
    id: 'step-3',
    stepNumber: 3,
    slug: 'selfie',
    title: 'Selfie Verification',
    description: 'Live selfie photo matching your identity document.',
    icon: 'Camera',
    enabled: true,
    fields: [
      { id: 'f-11', name: 'selfie', label: 'Selfie Photo', type: 'camera', required: true },
    ],
  },
  {
    id: 'step-4',
    stepNumber: 4,
    slug: 'address',
    title: 'Proof of Address',
    description: 'Document dated within the last 3 months showing your residential address.',
    icon: 'Home',
    enabled: true,
    fields: [
      { id: 'f-13', name: 'address_proof', label: 'Primary Page (Page 1)', type: 'file', required: true },
      { id: 'f-14', name: 'address_proof_2', label: 'Page 2 / Supporting Document', type: 'file', required: false },
    ],
  },
  {
    id: 'step-5',
    stepNumber: 5,
    slug: 'review',
    title: 'Review & Submit',
    description: 'Confirm all details and submit your application for compliance review.',
    icon: 'CheckSquare',
    enabled: true,
    fields: [],
  },
];

let stepsConfig: KycStepConfig[] = [...defaultSteps];

export const KycConfigStore = {
  getSteps(): KycStepConfig[] {
    return stepsConfig.sort((a, b) => a.stepNumber - b.stepNumber);
  },

  setSteps(steps: KycStepConfig[]): KycStepConfig[] {
    stepsConfig = steps.map((s, idx) => ({ ...s, stepNumber: idx + 1 }));
    return this.getSteps();
  },

  addStep(stepData: Omit<KycStepConfig, 'id' | 'stepNumber'>): KycStepConfig {
    const id = `step-${uuidv4()}`;
    const newStep: KycStepConfig = {
      ...stepData,
      id,
      stepNumber: stepsConfig.length + 1,
    };
    stepsConfig.push(newStep);
    return newStep;
  },

  updateStep(id: string, patch: Partial<KycStepConfig>): KycStepConfig | undefined {
    const idx = stepsConfig.findIndex((s) => s.id === id);
    if (idx === -1) return undefined;
    stepsConfig[idx] = { ...stepsConfig[idx], ...patch };
    return stepsConfig[idx];
  },

  deleteStep(id: string): boolean {
    const initialLen = stepsConfig.length;
    stepsConfig = stepsConfig.filter((s) => s.id !== id);
    // Re-index step numbers
    stepsConfig = stepsConfig.map((s, idx) => ({ ...s, stepNumber: idx + 1 }));
    return stepsConfig.length < initialLen;
  },

  resetDefaults(): KycStepConfig[] {
    stepsConfig = [...defaultSteps];
    return this.getSteps();
  },
};
