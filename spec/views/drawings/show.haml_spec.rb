require 'spec/spec_helper'

describe "drawings/show.haml" do
  before(:each) do
    @drawing = {
      'url' => 'drawing url',
      :children => []
    }
  end

  it "should display @drawing['url']" do
    assigns[:drawing] = @drawing
    render("/views/drawings/show.haml")
    rendered.should match(/#{@drawing['url']}/)
  end

  context "with children" do
    before(:each) do
      @drawing = {
        'url' => 'drawing url',
        :children => [{}]
      }
    end

    it "should display children" do
      assigns[:drawing] = @drawing
      render("/views/drawings/show.haml", :params => {:id => 123})
      rendered.should match(/Children/)
    end
  end

  context "with parent" do
    before(:each) do
      @drawing = {
        'url' => 'drawing url',
        :children => [],
        :parent => {}
      }
    end

    it "should display parent" do
      assigns[:drawing] = @drawing
      render("/views/drawings/show.haml")
      rendered.should match(/Parent/)
    end
  end
end