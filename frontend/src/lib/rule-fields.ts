export interface RuleFieldOption {
  value: string
  label: string
  group: string
}

export interface RuleFieldsResponse {
  fields?: RuleFieldOption[]
}

export function ruleFieldLabel(field: RuleFieldOption): string {
  return `${field.group} · ${field.label}`
}
