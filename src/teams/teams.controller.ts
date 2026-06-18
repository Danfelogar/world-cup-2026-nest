import { Controller, Get, Param, Logger, Query } from '@nestjs/common';
import { TeamsService } from './teams.service';

@Controller('seleccion')
export class TeamsController {
  private readonly logger = new Logger(TeamsController.name);

  constructor(private readonly teamsService: TeamsService) {}

  /**
   * GET /seleccion
   * List all 48 WC2026 teams
   */
  @Get()
  findAll(@Query('group') group?: string) {
    if (group) {
      return this.teamsService.findByGroup(group.toUpperCase());
    }
    return this.teamsService.findAll();
  }

  /**
   * GET /seleccion/grupos
   * All groups with standings
   */
  @Get('grupos')
  getGroupStandings() {
    return this.teamsService.getGroupStandings();
  }

  /**
   * GET /seleccion/:fbrefId/stats
   * Full stats for a team by FBref ID
   */
  @Get(':fbrefId/stats')
  getStats(@Param('fbrefId') fbrefId: string) {
    this.logger.log(`📊 Getting stats for: ${fbrefId}`);
    return this.teamsService.getTeamFullStats(fbrefId);
  }

  /**
   * GET /seleccion/:fbrefId
   * Team detail by FBref ID
   */
  @Get(':fbrefId')
  findOne(@Param('fbrefId') fbrefId: string) {
    return this.teamsService.findByFbrefId(fbrefId);
  }

  /**
   * GET /seleccion/confrontacion/:fbrefId1/:fbrefId2
   * Returns a comparative analysis between two national teams.
   * Used by Claude to make informed predictions.
   */
  @Get('confrontacion/:fbrefId1/:fbrefId2')
  confrontacion(
    @Param('fbrefId1') fbrefId1: string,
    @Param('fbrefId2') fbrefId2: string,
  ) {
    return this.teamsService.getConfrontacion(fbrefId1, fbrefId2);
  }
}
