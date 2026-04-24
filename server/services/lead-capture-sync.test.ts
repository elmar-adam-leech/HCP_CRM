import { describe, it, expect } from 'vitest';
import { detectFullNameFromBody, extractFieldsFromMappings } from './lead-capture-sync';
import type { FieldMapping } from '@shared/schema';

describe('detectFullNameFromBody (auto split-name detection)', () => {
  it('combines First Name + Last Name into the full name', () => {
    const body = [
      'You have a new lead!',
      'First Name: Meagan',
      'Last Name: Petri',
      'Email: meaganpetri@gmail.com',
    ].join('\n');
    expect(detectFullNameFromBody(body)).toBe('Meagan Petri');
  });

  it('returns just the first name when only First Name is present', () => {
    const body = 'First Name: Meagan\nEmail: meaganpetri@gmail.com';
    expect(detectFullNameFromBody(body)).toBe('Meagan');
  });

  it('returns just the last name when only Last Name is present', () => {
    const body = 'Last Name: Petri\nEmail: meaganpetri@gmail.com';
    expect(detectFullNameFromBody(body)).toBe('Petri');
  });

  it('prefers an explicit "Name:" line over split first/last fields', () => {
    const body = [
      'Name: Meagan Petri',
      'First Name: Meagan',
      'Last Name: Petri',
    ].join('\n');
    expect(detectFullNameFromBody(body)).toBe('Meagan Petri');
  });

  it('also accepts "Full Name:" and "Customer Name:" labels', () => {
    expect(detectFullNameFromBody('Full Name: Meagan Petri')).toBe('Meagan Petri');
    expect(detectFullNameFromBody('Customer Name: Meagan Petri')).toBe('Meagan Petri');
  });

  it('also accepts Given Name / Surname / Family Name labels', () => {
    expect(detectFullNameFromBody('Given Name: Meagan\nSurname: Petri')).toBe('Meagan Petri');
    expect(detectFullNameFromBody('Given Name: Meagan\nFamily Name: Petri')).toBe('Meagan Petri');
  });

  it('handles markdown bold around labels and extra whitespace', () => {
    const body = [
      '**First Name:**   Meagan  ',
      '__Last Name__:    Petri',
    ].join('\n');
    expect(detectFullNameFromBody(body)).toBe('Meagan Petri');
  });

  it('ignores placeholder dashes/blanks in either half', () => {
    const body = 'First Name: Meagan\nLast Name: -';
    expect(detectFullNameFromBody(body)).toBe('Meagan');
  });

  it('does not match label substrings inside other words (e.g. "named:")', () => {
    const body = 'Surnamed: not a real label';
    expect(detectFullNameFromBody(body)).toBeUndefined();
  });

  it('returns undefined when there are no name lines at all', () => {
    expect(detectFullNameFromBody('Phone: 555-1234')).toBeUndefined();
  });
});

describe('extractFieldsFromMappings — split first/last support', () => {
  it('combines firstName + lastName mappings into the canonical name', () => {
    const mappings: FieldMapping[] = [
      { label: 'First Name:', field: 'firstName' },
      { label: 'Last Name:', field: 'lastName' },
    ];
    const body = 'First Name: Meagan\nLast Name: Petri\nEmail: m@example.com';
    const result = extractFieldsFromMappings(body, mappings);
    expect(result.firstName).toBe('Meagan');
    expect(result.lastName).toBe('Petri');
    expect(result.name).toBe('Meagan Petri');
  });

  it('uses just the first name when only firstName is mapped/present', () => {
    const mappings: FieldMapping[] = [
      { label: 'First Name:', field: 'firstName' },
      { label: 'Last Name:', field: 'lastName' },
    ];
    const body = 'First Name: Meagan';
    const result = extractFieldsFromMappings(body, mappings);
    expect(result.name).toBe('Meagan');
  });

  it('uses just the last name when only lastName is mapped/present', () => {
    const mappings: FieldMapping[] = [
      { label: 'First Name:', field: 'firstName' },
      { label: 'Last Name:', field: 'lastName' },
    ];
    const body = 'Last Name: Petri';
    const result = extractFieldsFromMappings(body, mappings);
    expect(result.name).toBe('Petri');
  });

  it('does not overwrite an explicit "name" mapping with split fields', () => {
    const mappings: FieldMapping[] = [
      { label: 'Customer Name:', field: 'name' },
      { label: 'First Name:', field: 'firstName' },
      { label: 'Last Name:', field: 'lastName' },
    ];
    const body = [
      'Customer Name: Meagan Petri',
      'First Name: WrongFirst',
      'Last Name: WrongLast',
    ].join('\n');
    const result = extractFieldsFromMappings(body, mappings);
    expect(result.name).toBe('Meagan Petri');
  });

  it('backwards compat: two separate "name"-targeted mappings concatenate instead of overwriting', () => {
    // Legacy workaround some users tried: mapping both First Name and Last Name to `name`.
    // Previously the second mapping overwrote the first; now they concatenate.
    const mappings: FieldMapping[] = [
      { label: 'First Name:', field: 'name' },
      { label: 'Last Name:', field: 'name' },
    ];
    const body = 'First Name: Meagan\nLast Name: Petri';
    const result = extractFieldsFromMappings(body, mappings);
    expect(result.name).toBe('Meagan Petri');
  });

  it('still works for a single "Name" mapping', () => {
    const mappings: FieldMapping[] = [
      { label: 'Name:', field: 'name' },
    ];
    const body = 'Name: Meagan Petri\nPhone: 555-1234';
    const result = extractFieldsFromMappings(body, mappings);
    expect(result.name).toBe('Meagan Petri');
  });

  it('handles markdown bold and extra whitespace around labels', () => {
    const mappings: FieldMapping[] = [
      { label: 'First Name', field: 'firstName' },
      { label: 'Last Name', field: 'lastName' },
    ];
    const body = '**First Name:**   Meagan\n__Last Name:__   Petri';
    const result = extractFieldsFromMappings(body, mappings);
    expect(result.name).toBe('Meagan Petri');
  });
});
