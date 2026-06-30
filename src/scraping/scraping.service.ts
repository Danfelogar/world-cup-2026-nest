import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrowserContext, Page } from 'patchright';
import * as cheerio from 'cheerio';
import { PrismaService } from 'prisma/prisma.service';
import { createBrowser } from './browser-factory';
import { TeamsService } from 'src/teams/teams.service';

export interface ScrapedTeamStats {
  name: string;
  fbrefId: string;
  competition: string;
  season: string;
  matchesPlayed: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  cleanSheets: number;
  avgGoalsFor: number;
  avgGoalsAgainst: number;
  form: string;
}

export interface ScrapedPlayer {
  fbrefId: string;
  name: string;
  position: string;
  age: number;
  matchesPlayed: number;
  starts: number;
  minutes: number;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  goalsPer90: number;
  assistsPer90: number;
}

export interface ScrapedMatchResult {
  date: string;
  competition: string;
  round: string;
  venue: string;
  result: string;
  goalsFor: number;
  goalsAgainst: number;
  opponent: string;
  formation: string;
  oppFormation: string;
  attendance: number | null;
}

export interface FBrefTeamData {
  teamStats: ScrapedTeamStats | null;
  players: ScrapedPlayer[];
  recentMatches: ScrapedMatchResult[];
  form: string;
}

@Injectable()
export class ScrapingService {
  private readonly logger = new Logger(ScrapingService.name);
  private readonly delay: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => TeamsService))
    private readonly teamsService: TeamsService,
  ) {
    this.delay = this.config.get<number>('SCRAPING_DELAY_MS', 2000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async scrapeTeam(fbrefId: string, fbrefUrl: string): Promise<FBrefTeamData> {
    await this.sleep(this.delay);
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    try {
      context = await createBrowser();
      page = await context.newPage();

      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
      });

      this.logger.log(`🌐 Fetching: ${fbrefUrl}`);

      await page.goto(fbrefUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      const hasCaptcha =
        (await page.locator('text="security verification"').count()) > 0 ||
        (await page.locator('text="Verify you are human"').count()) > 0;

      if (hasCaptcha) {
        this.logger.warn(
          '⚠️ Captcha detectado. Esperando resolución manual...',
        );
        this.logger.log(
          '👉 Resuelve el captcha en la ventana del navegador en los próximos 60 segundos.',
        );
        await page.waitForFunction(
          () => {
            const text = document.body.innerText;
            return (
              !text.includes('security verification') &&
              !text.includes('Verify you are human')
            );
          },
          { timeout: 60000 },
        );
        this.logger.log('✅ Captcha resuelto, continuando...');
        await page.waitForTimeout(2000);
      }

      await page.waitForSelector(
        'table.stats_table, table#stats_standard, table#matchlogs_for',
        { timeout: 20000 },
      );

      const players = await this.parsePlayers(page);
      const recentMatches = await this.parseMatches(page);
      const teamStats = await this.parseTeamStats(page, fbrefId, recentMatches);
      const form = this.calculateForm(recentMatches);

      await this.prisma.scrapingLog.create({
        data: {
          url: fbrefUrl,
          status: 'success',
          message: `${players.length} players, ${recentMatches.length} matches`,
        },
      });

      return { teamStats, players, recentMatches, form };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed: ${message}`);
      return { teamStats: null, players: [], recentMatches: [], form: '' };
    } finally {
      if (page) await page.close();
      if (context) await context.close();
    }
  }

  private async parsePlayers(page: any): Promise<ScrapedPlayer[]> {
    const players: ScrapedPlayer[] = [];
    try {
      // Buscar tabla de estadísticas estándar
      const table = await page.$('table#stats_standard');
      if (!table) {
        this.logger.warn('⚠️  Table #stats_standard not found');
        return players;
      }

      const rows = await table.$$('tbody tr');
      for (const row of rows) {
        // Verificar si es fila de jugador (tiene enlace)
        const playerLink = await row.$('td[data-stat="player"] a');
        if (!playerLink) continue;

        const name = await playerLink.textContent();
        const href = await playerLink.getAttribute('href');
        const fbrefIdMatch = href?.match(/\/players\/([a-f0-9]+)\//);
        const fbrefId = fbrefIdMatch ? fbrefIdMatch[1] : '';

        if (!name || !fbrefId) continue;

        // Función helper para obtener texto de una celda
        const getText = async (stat: string): Promise<string> => {
          const cell = await row.$(`td[data-stat="${stat}"]`);
          return cell ? (await cell.textContent())?.trim() || '' : '';
        };

        const getNumber = async (stat: string): Promise<number> => {
          const text = await getText(stat);
          return parseFloat(text) || 0;
        };

        const position = await getText('position');
        const ageText = await getText('age');
        const age = parseInt(ageText.split('-')[0]) || 0;

        players.push({
          fbrefId,
          name: name.trim(),
          position,
          age,
          matchesPlayed: await getNumber('games'),
          starts: await getNumber('games_starts'),
          minutes: await getNumber('minutes'),
          goals: await getNumber('goals'),
          assists: await getNumber('assists'),
          yellowCards: await getNumber('cards_yellow'),
          redCards: await getNumber('cards_red'),
          goalsPer90: await getNumber('goals_per90'),
          assistsPer90: await getNumber('assists_per90'),
        });
      }
      this.logger.log(`👥 Parsed ${players.length} players`);
    } catch (error: any) {
      this.logger.warn(`Error parsing players: ${error.message}`);
    }
    return players;
  }

  private async parseMatches(page: any): Promise<ScrapedMatchResult[]> {
    const matches: ScrapedMatchResult[] = [];
    try {
      const table = await page.$('table#matchlogs_for');
      if (!table) {
        this.logger.warn('⚠️  Table #matchlogs_for not found');
        return matches;
      }

      const rows = await table.$$('tbody tr');
      for (const row of rows) {
        const resultCell = await row.$('td[data-stat="result"]');
        if (!resultCell) continue;

        const result = (await resultCell.textContent())?.trim() || '';
        if (!result || result === 'Match Report') continue; // Partidos futuros o vacíos

        const getText = async (stat: string): Promise<string> => {
          const cell = await row.$(
            `td[data-stat="${stat}"], th[data-stat="${stat}"]`,
          );
          return cell ? (await cell.textContent())?.trim() || '' : '';
        };

        const goalsFor = parseInt(await getText('goals_for')) || 0;
        const goalsAgainst = parseInt(await getText('goals_against')) || 0;
        const attendanceStr = (await getText('attendance')).replace(/,/g, '');
        const attendance = attendanceStr ? parseInt(attendanceStr) : null;

        const opponentLink = await row.$('td[data-stat="opponent"] a');
        const opponent = opponentLink
          ? await opponentLink.textContent()
          : await getText('opponent');

        matches.push({
          date: await getText('date'),
          competition: await getText('comp'),
          round: await getText('round'),
          venue: await getText('venue'),
          result,
          goalsFor,
          goalsAgainst,
          opponent: opponent?.trim() || '',
          formation: await getText('formation'),
          oppFormation: await getText('opp_formation'),
          attendance,
        });
      }
      this.logger.log(`⚽ Parsed ${matches.length} matches`);
    } catch (error: any) {
      this.logger.warn(`Error parsing matches: ${error.message}`);
    }
    return matches;
  }

  private async parseTeamStats(
    page: any,
    fbrefId: string,
    matches: ScrapedMatchResult[],
  ): Promise<ScrapedTeamStats | null> {
    try {
      const title = await page.title();
      const name = title.replace('Stats', '').replace('Men', '').trim();

      let wins = 0,
        draws = 0,
        losses = 0,
        goalsFor = 0,
        goalsAgainst = 0,
        cleanSheets = 0;
      const playedMatches = matches.filter(
        (m) => m.result && ['W', 'D', 'L'].includes(m.result),
      );

      for (const m of playedMatches) {
        if (m.result === 'W') wins++;
        else if (m.result === 'D') draws++;
        else if (m.result === 'L') losses++;
        goalsFor += m.goalsFor;
        goalsAgainst += m.goalsAgainst;
        if (m.goalsAgainst === 0) cleanSheets++;
      }

      const mp = playedMatches.length;

      return {
        name,
        fbrefId,
        competition: 'International Friendlies',
        season: '2026',
        matchesPlayed: mp,
        wins,
        draws,
        losses,
        goalsFor,
        goalsAgainst,
        goalDiff: goalsFor - goalsAgainst,
        cleanSheets,
        avgGoalsFor: mp > 0 ? parseFloat((goalsFor / mp).toFixed(2)) : 0,
        avgGoalsAgainst:
          mp > 0 ? parseFloat((goalsAgainst / mp).toFixed(2)) : 0,
        form: this.calculateForm(matches),
      };
    } catch (error: any) {
      this.logger.warn(`Error parsing team stats: ${error.message}`);
      return null;
    }
  }

  private calculateForm(matches: ScrapedMatchResult[]): string {
    return matches
      .filter((m) => m.result && ['W', 'D', 'L'].includes(m.result))
      .slice(-10)
      .map((m) => m.result)
      .join('');
  }

  async parseHtmlAndPersist(
    fbrefId: string,
    html: string,
  ): Promise<FBrefTeamData> {
    this.logger.log(
      `📄 Recibido HTML para ${fbrefId}, tamaño: ${html.length} caracteres`,
    );
    const $ = cheerio.load(html);

    const title = $('title').text();
    const teamName = title
      .replace(/Stats|Men|Women/g, '')
      .split('|')[0]
      .trim();
    const players = this.parsePlayersFromHtml($);
    const recentMatches = this.parseMatchesFromHtml($);
    const teamStats = this.parseTeamStatsFromHtml(
      $,
      fbrefId,
      recentMatches,
      teamName,
    );
    const form = this.calculateForm(recentMatches);

    const team = await this.prisma.nationalTeam.findUnique({
      where: { fbrefId },
    });
    if (team) {
      await this.teamsService.persistScrapedData(team.id, {
        teamStats,
        players,
        recentMatches,
        form,
      });
    } else {
      this.logger.warn(
        `Equipo con fbrefId ${fbrefId} no encontrado en BD. Ejecuta seed primero.`,
      );
    }

    return { teamStats, players, recentMatches, form };
  }

  private parsePlayersFromHtml($: cheerio.CheerioAPI): ScrapedPlayer[] {
    const players: ScrapedPlayer[] = [];

    // Buscar la tabla de estadísticas estándar (id empieza con 'stats_standard')
    const table = $('table[id*="stats_standard"]');
    if (!table.length) {
      this.logger.warn('⚠️ No se encontró tabla de estadísticas estándar');
      return players;
    }

    this.logger.log(`📊 Tabla encontrada con id: ${table.attr('id')}`);

    const rows = table.find('tbody tr');
    this.logger.log(`🔍 Filas totales: ${rows.length}`);

    rows.each((i, row) => {
      const $row = $(row);
      // Saltar filas de encabezado (over_header, thead)
      if ($row.hasClass('over_header') || $row.hasClass('thead')) return;

      // Buscar el enlace del jugador dentro de <th> o <td> con data-stat="player"
      const playerLink = $row.find('[data-stat="player"] a');
      if (!playerLink.length) {
        this.logger.debug(`Fila ${i + 1} no tiene enlace de jugador`);
        return;
      }

      const name = playerLink.text().trim();
      const href = playerLink.attr('href');
      const fbrefIdMatch = href?.match(/\/players\/([a-f0-9]+)\//);
      const fbrefId = fbrefIdMatch ? fbrefIdMatch[1] : '';
      if (!name || !fbrefId) return;

      const getText = (stat: string) =>
        $row.find(`[data-stat="${stat}"]`).text().trim();
      const getNumber = (stat: string) => parseFloat(getText(stat)) || 0;

      players.push({
        fbrefId,
        name,
        position: getText('position'),
        age: parseInt(getText('age').split('-')[0]) || 0,
        matchesPlayed: getNumber('games'),
        starts: getNumber('games_starts'),
        minutes: getNumber('minutes'),
        goals: getNumber('goals'),
        assists: getNumber('assists'),
        yellowCards: getNumber('cards_yellow'),
        redCards: getNumber('cards_red'),
        goalsPer90: getNumber('goals_per90'),
        assistsPer90: getNumber('assists_per90'),
      });
    });

    this.logger.log(`👥 Parseados ${players.length} jugadores desde HTML`);
    return players;
  }

  private parseMatchesFromHtml($: cheerio.CheerioAPI): ScrapedMatchResult[] {
    const matches: ScrapedMatchResult[] = [];
    const table = $('#matchlogs_for');
    if (!table.length) {
      this.logger.warn('⚠️ No se encontró la tabla #matchlogs_for');
      return matches;
    }
    this.logger.log(`📊 Tabla #matchlogs_for encontrada, buscando filas...`);
    table.find('tbody tr').each((i, row) => {
      const $row = $(row);
      const result = $row.find('td[data-stat="result"]').text().trim();
      if (!result || result === 'Match Report') return;

      const getText = (stat: string) =>
        $row
          .find(`td[data-stat="${stat}"], th[data-stat="${stat}"]`)
          .text()
          .trim();
      const goalsFor = parseInt(getText('goals_for')) || 0;
      const goalsAgainst = parseInt(getText('goals_against')) || 0;
      const attendanceStr = getText('attendance').replace(/,/g, '');
      const attendance = attendanceStr ? parseInt(attendanceStr) : null;
      const opponent =
        $row.find('td[data-stat="opponent"] a').text().trim() ||
        getText('opponent');

      matches.push({
        date: getText('date'),
        competition: getText('comp'),
        round: getText('round'),
        venue: getText('venue'),
        result,
        goalsFor,
        goalsAgainst,
        opponent,
        formation: getText('formation'),
        oppFormation: getText('opp_formation'),
        attendance,
      });
    });
    this.logger.log(`⚽ Parseados ${matches.length} partidos desde HTML`);
    return matches;
  }

  private parseTeamStatsFromHtml(
    $: cheerio.CheerioAPI,
    fbrefId: string,
    matches: ScrapedMatchResult[],
    teamName: string,
  ): ScrapedTeamStats | null {
    let wins = 0,
      draws = 0,
      losses = 0,
      goalsFor = 0,
      goalsAgainst = 0,
      cleanSheets = 0;
    const playedMatches = matches.filter(
      (m) => m.result && ['W', 'D', 'L'].includes(m.result),
    );
    for (const m of playedMatches) {
      if (m.result === 'W') wins++;
      else if (m.result === 'D') draws++;
      else if (m.result === 'L') losses++;
      goalsFor += m.goalsFor;
      goalsAgainst += m.goalsAgainst;
      if (m.goalsAgainst === 0) cleanSheets++;
    }
    const mp = playedMatches.length;
    return {
      name: teamName,
      fbrefId,
      competition: 'International Friendlies',
      season: '2026',
      matchesPlayed: mp,
      wins,
      draws,
      losses,
      goalsFor,
      goalsAgainst,
      goalDiff: goalsFor - goalsAgainst,
      cleanSheets,
      avgGoalsFor: mp > 0 ? parseFloat((goalsFor / mp).toFixed(2)) : 0,
      avgGoalsAgainst: mp > 0 ? parseFloat((goalsAgainst / mp).toFixed(2)) : 0,
      form: this.calculateForm(matches),
    };
  }
}
