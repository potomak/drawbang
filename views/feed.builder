builder do |xml|
  xml.instruct! :xml, :version => '1.0'
  xml.rss :version => "2.0" do
    xml.channel do
      xml.title "Draw!"
      xml.description "Drawings from Draw!"
      xml.link "http://draw.heroku.com/"

      @drawings.each do |drawing|
        xml.item do
          xml.title drawing[:id]
          xml.link drawing[:share_url]
          xml.description drawing[:id]
          xml.pubDate Time.at(drawing[:id].gsub(/\.png/, '').to_i).rfc822
          xml.guid drawing[:share_url]
        end
      end
    end
  end
end