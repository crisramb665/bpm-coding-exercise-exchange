import { Body, Controller, Post } from '@nestjs/common';
import { AuthUser } from '../common/auth/auth.types';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Roles } from '../common/auth/roles.guard';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { QuoteRow } from './quotes.repository';
import { QuotesService } from './quotes.service';

// Solo USER cotiza: COMPLIANCE recibe 403 (segregación de funciones, D14).
@Controller('quotes')
@Roles('USER')
export class QuotesController {
  constructor(private readonly service: QuotesService) {}

  @Post() // 201 por defecto en POST
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateQuoteDto): Promise<QuoteRow> {
    return this.service.create(user.id, dto);
  }
}
