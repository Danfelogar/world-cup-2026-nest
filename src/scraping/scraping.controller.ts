import {
  Controller,
  Post,
  Get,
  Param,
  HttpCode,
  HttpStatus,
  Logger,
  Query,
  Inject,
  forwardRef,
  Body,
} from '@nestjs/common';
import { ScrapingService } from './scraping.service';
import { TeamsService } from '../teams/teams.service';

@Controller('scraping')
export class ScrapingController {
  private readonly logger = new Logger(ScrapingController.name);

  constructor(
    private readonly scrapingService: ScrapingService,
    @Inject(forwardRef(() => TeamsService))
    private readonly teamsService: TeamsService,
  ) {}

  /** POST /scraping/seed — seed all 48 teams (metadata only) */
  @Post('seed')
  @HttpCode(HttpStatus.CREATED)
  async seedTeams() {
    const count = await this.teamsService.seedAllTeams();
    return { success: true, message: `Seeded ${count} teams into database` };
  }

  /** POST /scraping/team/:fbrefId — scrape a single team */
  @Post('team/:fbrefId')
  @HttpCode(HttpStatus.OK)
  async scrapeTeam(@Param('fbrefId') fbrefId: string) {
    this.logger.log(`🔄 Scraping team: ${fbrefId}`);
    const team = await this.teamsService.findByFbrefId(fbrefId);
    if (!team) {
      return {
        error: `Team ${fbrefId} not found. Run POST /scraping/seed first.`,
      };
    }
    const data = await this.scrapingService.scrapeTeam(fbrefId, team.fbrefUrl);
    await this.teamsService.persistScrapedData(team.id, data);
    return {
      success: true,
      team: team.name,
      stats: data.teamStats,
      playersFound: data.players.length,
      matchesFound: data.recentMatches.length,
      form: data.form,
    };
  }

  /** POST /scraping/group/:group — scrape all 4 teams in a group */
  @Post('group/:group')
  @HttpCode(HttpStatus.OK)
  async scrapeGroup(@Param('group') group: string) {
    this.logger.log(`🔄 Scraping Group ${group.toUpperCase()}`);
    const results = await this.teamsService.scrapeAndPersistGroup(
      group.toUpperCase(),
    );
    return { success: true, group: group.toUpperCase(), results };
  }

  /** POST /scraping/all?groups=A,B — scrape all (or subset) teams */
  @Post('all')
  @HttpCode(HttpStatus.ACCEPTED)
  scrapeAll(@Query('groups') groups?: string) {
    const targetGroups = groups?.split(',').map((g) => g.trim().toUpperCase());
    this.logger.log(
      `🔄 Starting scrape: ${targetGroups?.join(', ') ?? 'All groups'}`,
    );
    this.teamsService
      .scrapeAllTeams(targetGroups)
      .catch((err) => this.logger.error('Background scrape failed:', err));
    return {
      success: true,
      message: 'Scraping started in background. Check GET /scraping/logs',
      groups: targetGroups ?? 'A–L',
    };
  }

  /** GET /scraping/logs — recent scraping activity */
  @Get('logs')
  getLogs(@Query('limit') limit = '50') {
    return this.teamsService.getScrapingLogs(parseInt(limit));
  }

  @Post('upload')
  @HttpCode(HttpStatus.OK)
  async uploadHtml(
    @Body('fbrefId') fbrefId: string,
    @Body('html') html: string,
  ) {
    if (!fbrefId || !html) {
      return { error: 'Se requiere fbrefId y html' };
    }
    const data = await this.scrapingService.parseHtmlAndPersist(fbrefId, html);
    return {
      success: true,
      team: data.teamStats?.name,
      playersFound: data.players.length,
      matchesFound: data.recentMatches.length,
      form: data.form,
    };
  }
}
