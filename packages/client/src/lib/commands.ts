import {
  calendarConfigurationSchema,
  commandResultSchema,
  type CalendarConfiguration,
  type CommandRequest,
  type CommandResult,
  type CreatedEntity,
} from '@ambitime/shared';
import { api, expectOk } from './api';

/**
 * The client half of the single write path (spec §3.2).
 *
 * There is one function that writes, and it takes a command. Nothing in the UI
 * gets to `PATCH` anything: a screen that could would be a second write path,
 * and undo, audit and the future natural-language surface all assume there is
 * only the one.
 *
 * The request is typed by the shared union, so a form that assembles the wrong
 * parameters for its command type does not compile — the same schema the server
 * validates with, from the same file.
 */
export async function runCommand(request: CommandRequest): Promise<CommandResult> {
  const response = await api.api.commands.$post({ json: request });
  return commandResultSchema.parse(await expectOk(response));
}

/**
 * The id of the single entity of a kind the command created.
 *
 * Ids come from Postgres (§5.1), so a form that has just created a category and
 * wants to attach windows to it learns the id here rather than by re-reading
 * and matching on a name — which two renames between two requests can defeat.
 */
export function createdId(result: CommandResult, entity: CreatedEntity['entity']): string {
  const matches = result.created.filter((row) => row.entity === entity);
  if (matches.length !== 1) {
    throw new Error(`Expected the command to create exactly one ${entity}, not ${matches.length}`);
  }
  return matches[0]!.id;
}

/** Everything the settings screen edits, in one read (spec §4.3, §9.1). */
export async function fetchConfiguration(calendarId: string): Promise<CalendarConfiguration> {
  const response = await api.api.calendars[':calendarId'].configuration.$get({
    param: { calendarId },
  });

  return calendarConfigurationSchema.parse(await expectOk(response));
}
