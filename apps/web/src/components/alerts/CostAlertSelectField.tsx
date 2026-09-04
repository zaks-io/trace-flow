interface CostAlertSelectFieldProps {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}

export function CostAlertSelectField({ value, onChange, options }: CostAlertSelectFieldProps) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
