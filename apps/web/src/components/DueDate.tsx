/**
 * A task's due date as a list shows it: a small calendar icon, then the date in the
 * format chosen in Settings (`20/Nov` by default). With `todayDate` given, a date
 * that is today reads "Today" instead and takes the blue "today" colour.
 */
import { Ic } from '@prisms/ui';

import { formatDueDate, useDueDateFormatPref } from '../due-date-format';

export function DueDate({ date, todayDate, chip }: { date: string; todayDate?: string; chip?: boolean }) {
  const format = useDueDateFormatPref();
  const today = todayDate !== undefined && date === todayDate;
  return (
    <span
      className={`${chip ? 'px-due' : 'px-t-due'}${chip && today ? ' px-due--today' : ''}`}
      title={`Due ${formatDueDate(date, 'iso')}`}
      data-testid="due-date"
      data-date={date}
    >
      <Ic name="cal" />
      {today ? 'Today' : formatDueDate(date, format)}
    </span>
  );
}
