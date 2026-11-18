import type Anthropic from '@anthropic-ai/sdk';

/** The execution model finishes against the same results it just used. */
export function schedulingFinishTool():Anthropic.Tool {
  return {name:'finish_scheduling',description:'Finish the scheduling turn after handling each ready requested item. This only returns the answer; it performs no calendar or communication action.',input_schema:{
    type:'object',properties:{focus:{type:'string',description:'The CURRENT human request being answered, in one short clause. Earlier unfinished requests are background unless this message continues them.'},parts:{type:'array',items:{type:'object',properties:{
      kind:{type:'string',enum:['outcome','blocked','options'],description:'outcome reports completed work or answers a question; blocked states the actual blocker and next decision; options presents verified choices and must select their IDs.'},
      text:{type:'string',description:'Visible answer to the CURRENT message in the human’s language. Usually 1–3 short sentences: the result, or the real blocker and next decision. Cover each item requested now. Earlier unanswered questions remain pending without being repeated on an unrelated follow-up. For options, name the meeting and relevant attendee status; select IDs so the renderer supplies dates, clocks, zones and duration. A correction needs the corrected fact, not a full conversation recap. No future-work promise for an unperformed task.'},
      options:{type:'array',items:{type:'integer'},description:'All applicable IDs from scheduling_reply_options for this appointment, duration and attendee status. Present the returned choices in full, grouped across parts when statuses differ; omit a choice only for a specific human constraint or a duplicate, not to shorten the list. Keep IDs out of prose; refer to day and time. Use [] for ordinary outcome or blocker text.'},
    },required:['kind','text','options'],additionalProperties:false}}},required:['focus','parts'],additionalProperties:false}};
}
