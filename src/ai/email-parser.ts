import { GeneratedEmails } from '../types';

export class EmailParser {
  /**
   * Parse structured output from Claude CLI containing all 4 emails
   * Expected format:
   * ---RESEARCH---
   * [research summary]
   * ---INITIAL_SUBJECT---
   * [subject]
   * ---INITIAL_BODY---
   * [body]
   * ---FOLLOWUP1_SUBJECT---
   * [subject]
   * ---FOLLOWUP1_BODY---
   * [body]
   * ---FOLLOWUP2_SUBJECT---
   * [subject]
   * ---FOLLOWUP2_BODY---
   * [body]
   * ---FOLLOWUP3_SUBJECT---
   * [subject]
   * ---FOLLOWUP3_BODY---
   * [body]
   * ---END---
   */
  parseFullSequence(output: string): GeneratedEmails | null {
    try {
      const normalized = output.replace(/\r\n/g, '\n').trim();

      // Extract research (optional)
      const researchMatch = normalized.match(
        /---RESEARCH---\s*([\s\S]*?)\s*---RESUME_TYPE---|---RESEARCH---\s*([\s\S]*?)\s*---INITIAL_SUBJECT---/
      );
      const research_summary = researchMatch ? (researchMatch[1] || researchMatch[2]).trim() : undefined;

      // Extract resume type (optional)
      const resumeTypeMatch = normalized.match(
        /---RESUME_TYPE---\s*([\s\S]*?)\s*---INITIAL_SUBJECT---/
      );
      const resume_type = resumeTypeMatch
        ? resumeTypeMatch[1].trim().split('\n')[0].trim().toLowerCase()
        : 'data_scientist';

      // Normalise to valid values
      const validResumeTypes = ['data_scientist', 'data_analyst', 'business_analyst', 'ai_engineer', 'data_engineer'];
      const normalised_resume_type = validResumeTypes.includes(resume_type) ? resume_type : 'data_scientist';

      // Extract initial email
      const initialSubjectMatch = normalized.match(
        /---INITIAL_SUBJECT---\s*([\s\S]*?)\s*---INITIAL_BODY---/
      );
      const initialBodyMatch = normalized.match(
        /---INITIAL_BODY---\s*([\s\S]*?)\s*---FOLLOWUP1_SUBJECT---/
      );

      if (!initialSubjectMatch || !initialBodyMatch) {
        console.error('Failed to extract initial email');
        return null;
      }

      // Extract follow-up 1
      const followup1SubjectMatch = normalized.match(
        /---FOLLOWUP1_SUBJECT---\s*([\s\S]*?)\s*---FOLLOWUP1_BODY---/
      );
      const followup1BodyMatch = normalized.match(
        /---FOLLOWUP1_BODY---\s*([\s\S]*?)\s*---FOLLOWUP2_SUBJECT---/
      );

      if (!followup1SubjectMatch || !followup1BodyMatch) {
        console.error('Failed to extract follow-up 1');
        return null;
      }

      // Extract follow-up 2
      const followup2SubjectMatch = normalized.match(
        /---FOLLOWUP2_SUBJECT---\s*([\s\S]*?)\s*---FOLLOWUP2_BODY---/
      );
      const followup2BodyMatch = normalized.match(
        /---FOLLOWUP2_BODY---\s*([\s\S]*?)\s*---FOLLOWUP3_SUBJECT---/
      );

      if (!followup2SubjectMatch || !followup2BodyMatch) {
        console.error('Failed to extract follow-up 2');
        return null;
      }

      // Extract follow-up 3
      const followup3SubjectMatch = normalized.match(
        /---FOLLOWUP3_SUBJECT---\s*([\s\S]*?)\s*---FOLLOWUP3_BODY---/
      );
      const followup3BodyMatch = normalized.match(
        /---FOLLOWUP3_BODY---\s*([\s\S]*?)\s*---END---/
      );

      if (!followup3SubjectMatch || !followup3BodyMatch) {
        console.error('Failed to extract follow-up 3');
        return null;
      }

      const result: GeneratedEmails = {
        research_summary,
        resume_type: normalised_resume_type,
        initial_email_subject: initialSubjectMatch[1].trim(),
        initial_email: initialBodyMatch[1].trim(),
        follow_up_1_subject: followup1SubjectMatch[1].trim(),
        follow_up_1: followup1BodyMatch[1].trim(),
        follow_up_2_subject: followup2SubjectMatch[1].trim(),
        follow_up_2: followup2BodyMatch[1].trim(),
        follow_up_3_subject: followup3SubjectMatch[1].trim(),
        follow_up_3: followup3BodyMatch[1].trim(),
      };

      // Validate minimum content
      if (
        result.initial_email_subject.length < 5 ||
        result.initial_email.length < 50
      ) {
        console.error('Initial email content too short');
        return null;
      }

      console.log('Successfully parsed all 4 emails');
      return result;
    } catch (error) {
      console.error('Error parsing Claude output:', error);
      return null;
    }
  }

  // Parse batch output: one research block + N contact blocks
  parseBatchSequence(output: string, count: number): (GeneratedEmails | null)[] {
    const normalized = output.replace(/\r\n/g, '\n').trim();

    const researchMatch = normalized.match(/---RESEARCH---\s*([\s\S]*?)\s*---CONTACT_1---/);
    const research_summary = researchMatch ? researchMatch[1].trim() : undefined;

    return Array.from({ length: count }, (_, i) => {
      const n = i + 1;
      const blockMatch = normalized.match(
        new RegExp(`---CONTACT_${n}---\\s*([\\s\\S]*?)\\s*---END_CONTACT_${n}---`)
      );
      if (!blockMatch) {
        console.error(`Failed to extract contact block ${n}`);
        return null;
      }
      // Reuse single-contact parser by wrapping block in the expected format
      const block = `---RESEARCH---\n${research_summary || ''}\n${blockMatch[1].trim()}\n---END---`;
      const result = this.parseFullSequence(block);
      if (result && research_summary) result.research_summary = research_summary;
      return result;
    });
  }
}
